// Shared local-first JSON document store — extracted from FRIDAY's and TUESDAY's near-identical
// persistence/store.ts (TUESDAY's header: "Ported from FRIDAY's persistence/store.ts, including
// the Windows-hardened atomic write"). A tiny, dependency-free per-collection JSON file store
// plus JSONL append streams, write-through with an atomic temp-file rename hardened against
// Windows file-lock contention (antivirus, Search indexer, an open Explorer preview pane).
//
// TUESDAY has two writers (the Next server AND a standalone worker process) that can race on the
// same file, so its version additionally takes a cross-process advisory lock (an mkdir'd `.lock`
// directory — atomic by OS guarantee) around every read-modify-write cycle. This shared class
// adopts that tighter model unconditionally (reading fresh state INSIDE the same serialization
// point a write commits through) since it's strictly safer for concurrent in-process callers too
// and changes nothing for a single caller at a time — the cross-process mkdir lock itself stays
// opt-in via `withLock`, since FRIDAY is single-process and doesn't need it.
//
// CLARA has no equivalent — it does ad hoc per-feature JSON I/O — and is explicitly NOT part of
// this extraction; migrating it onto this store is separate, larger follow-up work.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface Entity {
  id: string;
}

const LOCK_STALE_MS = 10_000; // a lock older than this belongs to a crashed process — steal it
const LOCK_RETRY_MS = 25; // wait between acquisition attempts while the lock is held
const LOCK_TIMEOUT_MS = 5_000; // give up (throw) after this long without acquiring

export interface CollectionOptions {
  /** Take a cross-process mkdir lock around every mutation (TUESDAY: true, FRIDAY: false). */
  withLock?: boolean;
}

export class Collection<T extends Entity> {
  private file: string;
  private lockPath: string;
  private writing: Promise<void> = Promise.resolve();
  private seq = 0;
  private readonly useLock: boolean;

  constructor(dataDir: string, name: string, opts: CollectionOptions = {}) {
    this.file = path.join(dataDir, `${name}.json`);
    this.lockPath = `${this.file}.lock`;
    this.useLock = opts.withLock ?? false;
  }

  // Always read fresh from disk — no long-lived cache. Avoids desync under dev HMR or
  // out-of-band edits. Data is small (single operator).
  private async load(): Promise<T[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as T[];
    } catch {
      return [];
    }
  }

  // Acquire the cross-process advisory lock. Loops on mkdir; EEXIST means held by someone
  // else — steal it if stale (a crashed process must not deadlock the store), else wait and
  // retry until the timeout.
  private async acquireFileLock(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await fs.mkdir(this.lockPath);
        return; // dir created atomically — lock is ours
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          const st = await fs.stat(this.lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // Stale — holder crashed. Best-effort steal, then retry mkdir immediately
            // (another process may win the re-acquire race; that's fine).
            await fs.rmdir(this.lockPath).catch(() => {});
            continue;
          }
        } catch {
          /* lock vanished between mkdir and stat (holder released) — fall through to retry */
        }
        if (Date.now() >= deadline) throw new Error(`store lock timeout on ${this.file}`);
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
  }

  private async releaseFileLock(): Promise<void> {
    await fs.rmdir(this.lockPath).catch(() => {});
  }

  // Serialize a whole load→mutate→persist cycle: in-process always (via the this.writing
  // chain), cross-process too when useLock. The mutation body re-loads INSIDE the
  // serialization point — a pre-lock read can be stale the moment another writer commits
  // first. Reads outside a mutation (all/find/get) stay lock-free.
  private async withMutation<R>(fn: () => Promise<R>): Promise<R> {
    const run = async (): Promise<R> => {
      if (this.useLock) await this.acquireFileLock();
      try {
        return await fn();
      } finally {
        if (this.useLock) await this.releaseFileLock();
      }
    };
    const next = this.writing.catch(() => {}).then(run);
    this.writing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // Write-then-rename, hardened for Windows. `rename` over an existing file throws EPERM/EACCES/
  // EBUSY when another process holds a handle on the target (antivirus, the Search indexer, or —
  // commonly — an open Explorer window with the preview pane on the folder). We use a unique temp
  // name per write (so concurrent writers never collide), retry the rename through transient locks,
  // and finally fall back to writing the target directly so data is never lost.
  private async atomicWrite(rows: T[]): Promise<void> {
    const data = JSON.stringify(rows, null, 2);
    const tmp = `${this.file}.${process.pid}.${++this.seq}.tmp`;
    await fs.writeFile(tmp, data, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, this.file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === "EPERM" || code === "EACCES" || code === "EBUSY") && attempt < 8) {
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1))); // brief backoff, then retry
          continue;
        }
        // Last resort: overwrite the target in place (read-shared handles like the preview pane
        // don't block this the way rename does), then drop the temp file.
        try {
          await fs.writeFile(this.file, data, "utf8");
          await fs.rm(tmp, { force: true }).catch(() => {});
          return;
        } catch (fallbackErr) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw fallbackErr;
        }
      }
    }
  }

  async all(): Promise<T[]> {
    return this.load();
  }

  async find(pred: (row: T) => boolean): Promise<T[]> {
    return (await this.load()).filter(pred);
  }

  async get(id: string): Promise<T | null> {
    return (await this.load()).find((r) => r.id === id) ?? null;
  }

  async insert(row: T): Promise<T> {
    await this.withMutation(async () => {
      const rows = await this.load();
      rows.unshift(row);
      await this.atomicWrite(rows);
    });
    return row;
  }

  /**
   * @param opts.onlyIf Compare-and-set predicate evaluated against the freshly loaded row inside
   * the mutation. When it fails (or the row is gone) the update writes nothing and returns null —
   * the CAS primitive an approval pipeline builds guarded transitions on (pending→approved etc.).
   */
  async update(id: string, patch: Partial<T>, opts?: { onlyIf?: (row: T) => boolean }): Promise<T | null> {
    return this.withMutation(async () => {
      const rows = await this.load();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return null;
      if (opts?.onlyIf && !opts.onlyIf(rows[idx])) return null;
      rows[idx] = { ...rows[idx], ...patch, id };
      await this.atomicWrite(rows);
      return rows[idx];
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.withMutation(async () => {
      const rows = await this.load();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      rows.splice(idx, 1);
      await this.atomicWrite(rows);
      return true;
    });
  }

  // Upsert many rows by id in one pass + a single write (used by bulk importers, where writing
  // per-row would be O(n²) over hundreds of records). `merge` keeps existing fields (e.g. an
  // operator's `active` toggle) not present on the incoming row.
  async upsertMany(rows: T[], merge = true): Promise<{ inserted: number; updated: number }> {
    return this.withMutation(async () => {
      const all = await this.load();
      const byId = new Map(all.map((r, i) => [r.id, i]));
      let inserted = 0, updated = 0;
      for (const row of rows) {
        const idx = byId.get(row.id);
        if (idx === undefined) {
          all.push(row);
          byId.set(row.id, all.length - 1);
          inserted++;
        } else {
          all[idx] = merge ? { ...all[idx], ...row } : row;
          updated++;
        }
      }
      await this.atomicWrite(all);
      return { inserted, updated };
    });
  }

  // Upsert by a NATURAL key (not id): rows sharing keyOf(row) collapse to one record. `replaceIf`
  // decides whether an incoming row overwrites an existing same-key row (default: always) — a
  // precedence predicate so e.g. an export row can win over a scrape row. Dedups within the
  // incoming batch too (a later row with an earlier row's key upserts against it).
  async upsertByKey(
    rows: T[],
    keyOf: (row: T) => string,
    replaceIf: (existing: T, incoming: T) => boolean = () => true,
  ): Promise<{ inserted: number; updated: number; skipped: number }> {
    return this.withMutation(async () => {
      const all = await this.load();
      const byKey = new Map<string, number>();
      all.forEach((r, i) => byKey.set(keyOf(r), i));
      let inserted = 0, updated = 0, skipped = 0;
      for (const row of rows) {
        const key = keyOf(row);
        const idx = byKey.get(key);
        if (idx === undefined) {
          all.push(row);
          byKey.set(key, all.length - 1);
          inserted++;
        } else if (replaceIf(all[idx], row)) {
          all[idx] = row;
          updated++;
        } else {
          skipped++;
        }
      }
      await this.atomicWrite(all);
      return { inserted, updated, skipped };
    });
  }
}

// ── Append-only JSONL stream (logs, messages) ────────────────────────────
export class Stream<T extends Entity> {
  private file: string;
  constructor(dataDir: string, name: string) {
    this.file = path.join(dataDir, `${name}.jsonl`);
  }
  async append(row: T): Promise<T> {
    await fs.appendFile(this.file, JSON.stringify(row) + "\n", "utf8");
    return row;
  }
  async tail(limit = 200, filter?: (row: T) => boolean): Promise<T[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const rows: T[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const row = JSON.parse(s) as T;
        if (!filter || filter(row)) rows.push(row);
      } catch {
        /* skip malformed */
      }
    }
    return rows.slice(-limit);
  }
}
