// Shared notification policy — the chief-of-staff ladder, extracted so FRIDAY/TUESDAY/CLARA stop
// re-deciding (differently) when the owner's phone should buzz. The POLICY lives here; DELIVERY
// stays in each app's own notify chokepoint. Apps call decide() → get {send|queue|drop}, perform
// their own channel sends, then commit() the fact of the send; queue-bound items go through
// enqueue() and drain later (the daily brief / digest) via the two-phase peekQueue()/ackQueue().
//
// The ladder:
//   emergency  — REQUIRES a category ∈ {revenue, production, security, family}; without one it is
//                demoted to `timely` (an "emergency" nobody can name isn't one). Sends now,
//                SMS/call suggested, exempt from quiet hours and away mode — but still deduped
//                and still subject to an explicit per-kind hourly cap (a looping pager is noise,
//                not an incident).
//   timely     — sends now via email/in-app ONLY (never SMS); respects quiet hours and away mode
//                (queued instead, with the reason recorded).
//   normal/low — always queued for the daily brief. No real-time channel, ever.
//
// State is durable (file-backed at <dataDir>/notify-policy-state.json) precisely because the
// in-memory dedupe maps this replaces die on every process restart — FRIDAY's watchdog restarts
// made its 90s in-memory window useless. Writes are read-modify-write, serialized in-process and
// guarded cross-process by a best-effort mkdir lock (TUESDAY runs a server AND a worker), with the
// Windows-hardened tmp+rename pattern from src/store.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
// Extensionless on purpose (repo convention, e.g. ostasks → "../osmcp"): consuming apps typecheck
// these sources through the file: link WITHOUT allowImportingTsExtensions, so a literal ".ts"
// specifier is a TS5097 error for them. `npm test` (node --test needs explicit extensions) covers
// the gap with the resolver hook in scripts/test/ts-ext-hooks.mjs.
import { parseQuietHours } from "../notify";

export type Priority = "emergency" | "timely" | "normal" | "low";
export type EmergencyCategory = "revenue" | "production" | "security" | "family";
export type Channel = "sms" | "call" | "email" | "inapp";

export interface NotifyPolicyRequest {
  kind: string; // short tag, e.g. "uptime" | "approval" | "injection.detected" — also the cap key
  text: string;
  priority: Priority;
  /** Required for `emergency` to actually page — missing/invalid demotes the request to `timely`. */
  category?: EmergencyCategory;
  /** Durable dedupe key. Omitted = no dedupe (every call is fresh). */
  dedupeKey?: string;
  /** Opaque app payload carried on queued items (emailText, approvalId, clientId, …). */
  meta?: Record<string, unknown>;
}

export interface QueuedNotification {
  id: string; // stable uuid — /inbox "done", ackQueue, and brief drains all target this
  kind: string;
  text: string;
  priority: Priority;
  at: string; // ISO enqueue time
  category?: EmergencyCategory;
  meta?: Record<string, unknown>;
}

export type Decision =
  | { action: "send"; channels: Channel[]; priority: "emergency" | "timely"; demoted?: boolean }
  | { action: "queue"; reason: "batched" | "quiet-hours" | "away"; demoted?: boolean }
  | { action: "drop"; reason: "dedupe" | "cap" };

export interface NotifyPolicyConfig {
  app: string; // "FRIDAY" | "TUESDAY" | "CLARA" — logs/diagnostics only
  dataDir: string; // where notify-policy-state.json lives
  quietHours?: string; // "START-END" 24h local (parseQuietHours grammar). Default "22-7".
  dedupeTtlMs?: number; // default 6h (TUESDAY's proven notify-state model)
  /** Explicit opt-in per kind. A kind with no entry is uncapped — caps are for known flappers. */
  perKindHourlyCap?: Record<string, number>;
  /** Away mode hook — timely holds while away; emergency pages through. */
  isAway?: () => boolean | Promise<boolean>;
  /** Clock injection for tests. */
  now?: () => Date;
}

export interface NotifyPolicy {
  decide(req: NotifyPolicyRequest): Promise<Decision>;
  /** Record a performed send: stamps the dedupe key and the per-kind hourly counter. */
  commit(req: NotifyPolicyRequest): Promise<void>;
  /** Queue for the brief. Also stamps the dedupe key so re-fires don't queue duplicates. */
  enqueue(req: NotifyPolicyRequest): Promise<QueuedNotification>;
  peekQueue(): Promise<QueuedNotification[]>;
  /** Two-phase drain: remove ONLY the ids actually delivered. Returns how many came off. */
  ackQueue(ids: string[]): Promise<number>;
  /** Same removal primitive for out-of-band dismissal (e.g. CLARA /inbox "done"). */
  removeQueued(ids: string[]): Promise<number>;
}

interface PolicyState {
  seen: Record<string, string>; // dedupeKey → ISO stamp
  queue: QueuedNotification[];
  counters: Record<string, string[]>; // kind → ISO send stamps within the last hour
}

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const QUEUE_CAP = 200; // a full queue means something upstream is looping — drop oldest, loudly

const CATEGORIES: readonly string[] = ["revenue", "production", "security", "family"];

// Cross-process advisory lock (mkdir is atomic). Best-effort: a notification policy must never
// deadlock its caller, so on timeout we proceed unlocked rather than throw.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;

export function createNotifyPolicy(cfg: NotifyPolicyConfig): NotifyPolicy {
  const file = path.join(cfg.dataDir, "notify-policy-state.json");
  const lockPath = `${file}.lock`;
  const ttl = cfg.dedupeTtlMs ?? DEFAULT_TTL_MS;
  const now = cfg.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  let seq = 0;

  async function load(): Promise<PolicyState> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<PolicyState>;
      return { seen: parsed.seen ?? {}, queue: parsed.queue ?? [], counters: parsed.counters ?? {} };
    } catch {
      return { seen: {}, queue: [], counters: {} };
    }
  }

  // tmp+rename, hardened for Windows (rename over a handle-held target throws EPERM/EACCES/EBUSY —
  // antivirus, Search indexer, Explorer preview pane). Unique temp name per write; retry; fall back
  // to an in-place overwrite so state is never lost.
  async function persist(state: PolicyState): Promise<void> {
    await fs.mkdir(cfg.dataDir, { recursive: true }).catch(() => {});
    const data = JSON.stringify(state, null, 2);
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    await fs.writeFile(tmp, data, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === "EPERM" || code === "EACCES" || code === "EBUSY") && attempt < 8) {
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
          continue;
        }
        try {
          await fs.writeFile(file, data, "utf8");
        } finally {
          await fs.rm(tmp, { force: true }).catch(() => {});
        }
        return;
      }
    }
  }

  async function acquireFileLock(): Promise<boolean> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await fs.mkdir(lockPath, { recursive: false });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          // dataDir itself doesn't exist yet — create it and retry the lock
          await fs.mkdir(cfg.dataDir, { recursive: true }).catch(() => {});
          continue;
        }
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
        try {
          const st = await fs.stat(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await fs.rmdir(lockPath).catch(() => {}); // holder crashed — steal
            continue;
          }
        } catch {
          /* lock vanished between mkdir and stat — retry */
        }
        if (Date.now() >= deadline) {
          console.warn(`[${cfg.app}/notify-policy] lock timeout on ${file} — proceeding unlocked`);
          return false;
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
  }

  // Serialize a whole load→mutate→persist cycle: in-process via the promise chain, cross-process
  // via the mkdir lock. Reads outside a mutation (decide/peekQueue) stay lock-free.
  function withMutation<R>(fn: (state: PolicyState) => Promise<R> | R): Promise<R> {
    const run = async (): Promise<R> => {
      const locked = await acquireFileLock();
      try {
        const state = await load();
        const out = await fn(state);
        await persist(state);
        return out;
      } finally {
        if (locked) await fs.rmdir(lockPath).catch(() => {});
      }
    };
    const next = chain.then(run, run);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function pruneSeen(state: PolicyState, at: number): void {
    for (const [k, v] of Object.entries(state.seen)) {
      if (at - new Date(v).getTime() > ttl) delete state.seen[k];
    }
  }

  function pruneCounters(state: PolicyState, at: number): void {
    for (const [kind, stamps] of Object.entries(state.counters)) {
      const kept = stamps.filter((s) => at - new Date(s).getTime() < HOUR_MS);
      if (kept.length) state.counters[kind] = kept;
      else delete state.counters[kind];
    }
  }

  // Missing/invalid category demotes emergency → timely. An unnameable emergency is a bug in the
  // caller, not a reason to page at 3am — the message still goes out immediately, just email/in-app.
  function normalize(req: NotifyPolicyRequest): { priority: Priority; demoted: boolean } {
    if (req.priority === "emergency" && !(req.category && CATEGORIES.includes(req.category))) {
      return { priority: "timely", demoted: true };
    }
    return { priority: req.priority, demoted: false };
  }

  function dedupeHit(state: PolicyState, req: NotifyPolicyRequest, at: number): boolean {
    if (!req.dedupeKey) return false;
    const prev = state.seen[req.dedupeKey];
    return Boolean(prev && at - new Date(prev).getTime() < ttl);
  }

  function capHit(state: PolicyState, kind: string, at: number): boolean {
    const cap = cfg.perKindHourlyCap?.[kind];
    if (cap === undefined || cap === null) return false;
    const stamps = state.counters[kind] ?? [];
    return stamps.filter((s) => at - new Date(s).getTime() < HOUR_MS).length >= cap;
  }

  async function decide(req: NotifyPolicyRequest): Promise<Decision> {
    const at = now();
    const atMs = at.getTime();
    const state = await load();
    // Dedupe first — it applies to every rung of the ladder, emergencies included.
    if (dedupeHit(state, req, atMs)) return { action: "drop", reason: "dedupe" };
    const { priority, demoted } = normalize(req);
    const flag = demoted ? { demoted: true } : {};

    if (priority === "emergency") {
      if (capHit(state, req.kind, atMs)) return { action: "drop", reason: "cap" };
      // Quiet-hours- and away-exempt: an incident is an incident.
      return { action: "send", channels: ["sms", "call", "email", "inapp"], priority: "emergency" };
    }
    if (priority === "timely") {
      if (parseQuietHours(cfg.quietHours ?? "22-7", at)) return { action: "queue", reason: "quiet-hours", ...flag };
      let away = false;
      try {
        away = Boolean(await cfg.isAway?.());
      } catch {
        /* status read failed — treat as present */
      }
      if (away) return { action: "queue", reason: "away", ...flag };
      if (capHit(state, req.kind, atMs)) return { action: "drop", reason: "cap" };
      return { action: "send", channels: ["email", "inapp"], priority: "timely", ...flag };
    }
    return { action: "queue", reason: "batched" }; // normal/low — the daily brief's material
  }

  function stamp(state: PolicyState, req: NotifyPolicyRequest, at: Date): void {
    if (req.dedupeKey) state.seen[req.dedupeKey] = at.toISOString();
  }

  async function commit(req: NotifyPolicyRequest): Promise<void> {
    const at = now();
    await withMutation((state) => {
      pruneSeen(state, at.getTime());
      pruneCounters(state, at.getTime());
      stamp(state, req, at);
      (state.counters[req.kind] ??= []).push(at.toISOString());
    });
  }

  async function enqueue(req: NotifyPolicyRequest): Promise<QueuedNotification> {
    const at = now();
    const { priority } = normalize(req);
    const item: QueuedNotification = {
      id: randomUUID(),
      kind: req.kind,
      text: req.text,
      priority,
      at: at.toISOString(),
      ...(req.category ? { category: req.category } : {}),
      ...(req.meta ? { meta: req.meta } : {}),
    };
    await withMutation((state) => {
      pruneSeen(state, at.getTime());
      stamp(state, req, at); // a queued re-fire is still a fire — dedupe it like a send
      state.queue.push(item);
      const dropped = state.queue.length - QUEUE_CAP;
      if (dropped > 0) {
        console.warn(`[${cfg.app}/notify-policy] queue over cap — dropping ${dropped} oldest queued item(s); something upstream is looping`);
        state.queue = state.queue.slice(-QUEUE_CAP);
      }
    });
    return item;
  }

  async function peekQueue(): Promise<QueuedNotification[]> {
    return (await load()).queue.slice();
  }

  async function removeByIds(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const wanted = new Set(ids);
    return withMutation((state) => {
      const before = state.queue.length;
      state.queue = state.queue.filter((i) => !wanted.has(i.id));
      return before - state.queue.length;
    });
  }

  return {
    decide,
    commit,
    enqueue,
    peekQueue,
    ackQueue: removeByIds,
    removeQueued: removeByIds,
  };
}
