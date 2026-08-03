// Unit tests for the notify-policy decide matrix — run with `npm test` (node --test, native TS
// type-stripping, Node >= 23). Covers priority × quiet × away × dedupe × cap × missing-category
// demotion, plus queue lifecycle and the durability property the module exists for (state survives
// a "process restart", i.e. a fresh createNotifyPolicy over the same dataDir).

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNotifyPolicy, type NotifyPolicyConfig, type NotifyPolicyRequest } from "./index.ts";

// Fixed local times: quiet window is the default "22-7", so 23:00 is quiet and 12:00 is not.
const QUIET = new Date(2026, 6, 30, 23, 0, 0, 0);
const DAY = new Date(2026, 6, 30, 12, 0, 0, 0);

let n = 0;
async function freshDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `notify-policy-test-${process.pid}-${++n}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function makePolicy(over: Partial<NotifyPolicyConfig> = {}) {
  const dataDir = over.dataDir ?? (await freshDir());
  return {
    dataDir,
    policy: createNotifyPolicy({ app: "TEST", dataDir, now: () => DAY, ...over }),
  };
}

const req = (over: Partial<NotifyPolicyRequest> = {}): NotifyPolicyRequest => ({
  kind: "uptime",
  text: "site down",
  priority: "emergency",
  category: "production",
  ...over,
});

test("emergency with category sends now with SMS/call channels", async () => {
  const { policy } = await makePolicy();
  const d = await policy.decide(req());
  assert.equal(d.action, "send");
  if (d.action === "send") {
    assert.equal(d.priority, "emergency");
    assert.ok(d.channels.includes("sms"));
    assert.ok(d.channels.includes("call"));
    assert.equal(d.demoted, undefined);
  }
});

test("emergency is quiet-hours-exempt and away-exempt", async () => {
  const { policy } = await makePolicy({ now: () => QUIET, isAway: () => true });
  const d = await policy.decide(req());
  assert.equal(d.action, "send");
});

test("emergency without a category demotes to timely (no SMS)", async () => {
  const { policy } = await makePolicy();
  const d = await policy.decide(req({ category: undefined }));
  assert.equal(d.action, "send");
  if (d.action === "send") {
    assert.equal(d.priority, "timely");
    assert.equal(d.demoted, true);
    assert.ok(!d.channels.includes("sms"));
    assert.ok(!d.channels.includes("call"));
    assert.ok(d.channels.includes("email"));
  }
});

test("emergency with a bogus category also demotes", async () => {
  const { policy } = await makePolicy();
  const d = await policy.decide(req({ category: "vibes" as never }));
  assert.equal(d.action, "send");
  if (d.action === "send") assert.equal(d.priority, "timely");
});

test("demoted emergency respects quiet hours (queues, keeps the demotion flag)", async () => {
  const { policy } = await makePolicy({ now: () => QUIET });
  const d = await policy.decide(req({ category: undefined }));
  assert.deepEqual(d, { action: "queue", reason: "quiet-hours", demoted: true });
});

test("timely sends email/in-app outside quiet hours — never SMS", async () => {
  const { policy } = await makePolicy();
  const d = await policy.decide(req({ priority: "timely", category: undefined }));
  assert.equal(d.action, "send");
  if (d.action === "send") {
    assert.equal(d.priority, "timely");
    assert.deepEqual([...d.channels].sort(), ["email", "inapp"]);
  }
});

test("timely queues during quiet hours", async () => {
  const { policy } = await makePolicy({ now: () => QUIET });
  const d = await policy.decide(req({ priority: "timely" }));
  assert.deepEqual(d, { action: "queue", reason: "quiet-hours" });
});

test("timely queues while away; emergency does not", async () => {
  const { policy } = await makePolicy({ isAway: async () => true });
  assert.deepEqual(await policy.decide(req({ priority: "timely" })), { action: "queue", reason: "away" });
  assert.equal((await policy.decide(req())).action, "send");
});

test("isAway throwing is treated as present (timely still sends)", async () => {
  const { policy } = await makePolicy({
    isAway: () => {
      throw new Error("status file unreadable");
    },
  });
  assert.equal((await policy.decide(req({ priority: "timely" }))).action, "send");
});

test("normal and low always queue for the brief, even mid-day while present", async () => {
  const { policy } = await makePolicy();
  assert.deepEqual(await policy.decide(req({ priority: "normal" })), { action: "queue", reason: "batched" });
  assert.deepEqual(await policy.decide(req({ priority: "low" })), { action: "queue", reason: "batched" });
});

test("custom quietHours string is honored (minute form)", async () => {
  const { policy } = await makePolicy({ quietHours: "11:30-13", now: () => DAY }); // 12:00 is inside
  assert.deepEqual(await policy.decide(req({ priority: "timely" })), { action: "queue", reason: "quiet-hours" });
});

test("dedupe: a committed key drops repeats — emergencies included — until the TTL lapses", async () => {
  const clock = { at: DAY };
  const { policy } = await makePolicy({ now: () => clock.at, dedupeTtlMs: 60_000 });
  const r = req({ dedupeKey: "down:site-a" });
  assert.equal((await policy.decide(r)).action, "send");
  await policy.commit(r);
  assert.deepEqual(await policy.decide(r), { action: "drop", reason: "dedupe" });
  clock.at = new Date(DAY.getTime() + 61_000); // past TTL — fires again
  assert.equal((await policy.decide(r)).action, "send");
});

test("dedupe: enqueue stamps the key too, so re-fires don't queue duplicates", async () => {
  const { policy } = await makePolicy();
  const r = req({ priority: "normal", dedupeKey: "digest:item-1" });
  await policy.enqueue(r);
  assert.deepEqual(await policy.decide(r), { action: "drop", reason: "dedupe" });
  assert.equal((await policy.peekQueue()).length, 1);
});

test("per-kind hourly cap drops emergency and timely sends past the cap; other kinds unaffected", async () => {
  const clock = { at: DAY };
  const { policy } = await makePolicy({ now: () => clock.at, perKindHourlyCap: { uptime: 2 } });
  await policy.commit(req());
  await policy.commit(req());
  assert.deepEqual(await policy.decide(req()), { action: "drop", reason: "cap" });
  assert.deepEqual(await policy.decide(req({ priority: "timely" })), { action: "drop", reason: "cap" });
  assert.equal((await policy.decide(req({ kind: "spend" }))).action, "send"); // uncapped kind
  clock.at = new Date(DAY.getTime() + HOURISH);
  assert.equal((await policy.decide(req())).action, "send"); // counter window rolled
});
const HOURISH = 61 * 60_000;

test("uncapped by default — repeated commits of an uncapped kind keep sending", async () => {
  const { policy } = await makePolicy();
  for (let i = 0; i < 5; i++) await policy.commit(req({ dedupeKey: undefined }));
  assert.equal((await policy.decide(req())).action, "send");
});

test("queue lifecycle: enqueue → stable uuid ids → ackQueue removes only what was delivered", async () => {
  const { policy } = await makePolicy();
  const a = await policy.enqueue(req({ priority: "normal", text: "one" }));
  const b = await policy.enqueue(req({ priority: "low", text: "two" }));
  assert.ok(a.id && b.id && a.id !== b.id);
  const q = await policy.peekQueue();
  assert.deepEqual(q.map((i) => i.text), ["one", "two"]);
  assert.equal(await policy.ackQueue([a.id]), 1);
  assert.deepEqual((await policy.peekQueue()).map((i) => i.text), ["two"]);
  assert.equal(await policy.removeQueued([b.id]), 1);
  assert.equal((await policy.peekQueue()).length, 0);
  assert.equal(await policy.ackQueue(["nope"]), 0);
});

test("queued items carry meta and category through the drain", async () => {
  const { policy } = await makePolicy();
  await policy.enqueue(req({ priority: "normal", meta: { emailText: "long body", clientId: "c1" } }));
  const [item] = await policy.peekQueue();
  assert.deepEqual(item.meta, { emailText: "long body", clientId: "c1" });
  assert.equal(item.priority, "normal");
});

test("state is durable across policy instances (the watchdog-restart case)", async () => {
  const dataDir = await freshDir();
  const first = createNotifyPolicy({ app: "TEST", dataDir, now: () => DAY });
  const r = req({ dedupeKey: "down:site-b" });
  await first.commit(r);
  await first.enqueue(req({ priority: "normal", text: "queued before restart" }));
  // "Restart": a brand-new instance over the same dataDir still knows both facts.
  const second = createNotifyPolicy({ app: "TEST", dataDir, now: () => DAY });
  assert.deepEqual(await second.decide(r), { action: "drop", reason: "dedupe" });
  assert.deepEqual((await second.peekQueue()).map((i) => i.text), ["queued before restart"]);
});

test("no dedupeKey means no dedupe — identical requests keep sending", async () => {
  const { policy } = await makePolicy();
  const r = req({ dedupeKey: undefined });
  await policy.commit(r);
  assert.equal((await policy.decide(r)).action, "send");
});
