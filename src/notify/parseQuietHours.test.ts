// Unit tests for parseQuietHours — run with `npm test` (node --test, native TS type-stripping,
// Node >= 23). The invariant that matters most: plain "H-H" specs behave EXACTLY as the original
// hour-only parser did; minute forms ("22:30-7") are newly accepted instead of silently disabling
// quiet hours (the divergent-parser bug that bit CLARA's notify config).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuietHours } from "./index.ts";

// Fixed local-time helper — parseQuietHours reads getHours()/getMinutes() (local), so build local dates.
const at = (h: number, m = 0) => new Date(2026, 6, 30, h, m, 0, 0);

test("plain hour spec, midnight wrap ('22-7') — legacy behavior preserved", () => {
  assert.equal(parseQuietHours("22-7", at(22, 0)), true); // start inclusive
  assert.equal(parseQuietHours("22-7", at(23, 59)), true);
  assert.equal(parseQuietHours("22-7", at(0, 0)), true);
  assert.equal(parseQuietHours("22-7", at(6, 59)), true);
  assert.equal(parseQuietHours("22-7", at(7, 0)), false); // end exclusive
  assert.equal(parseQuietHours("22-7", at(12, 0)), false);
  assert.equal(parseQuietHours("22-7", at(21, 59)), false);
});

test("plain hour spec, same-day window ('9-17')", () => {
  assert.equal(parseQuietHours("9-17", at(8, 59)), false);
  assert.equal(parseQuietHours("9-17", at(9, 0)), true);
  assert.equal(parseQuietHours("9-17", at(16, 59)), true);
  assert.equal(parseQuietHours("9-17", at(17, 0)), false);
});

test("degenerate equal-ends spec ('7-7') is an empty window — legacy behavior", () => {
  assert.equal(parseQuietHours("7-7", at(7, 0)), false);
  assert.equal(parseQuietHours("7-7", at(3, 0)), false);
});

test("whitespace tolerance — legacy behavior", () => {
  assert.equal(parseQuietHours("  22 - 7  ", at(23, 0)), true);
  assert.equal(parseQuietHours("22- 7", at(12, 0)), false);
});

test("minute form on the start side ('22:30-7') with midnight wrap", () => {
  assert.equal(parseQuietHours("22:30-7", at(22, 29)), false);
  assert.equal(parseQuietHours("22:30-7", at(22, 30)), true);
  assert.equal(parseQuietHours("22:30-7", at(0, 15)), true);
  assert.equal(parseQuietHours("22:30-7", at(6, 59)), true);
  assert.equal(parseQuietHours("22:30-7", at(7, 0)), false);
});

test("minute form on the end side ('9-17:45')", () => {
  assert.equal(parseQuietHours("9-17:45", at(17, 44)), true);
  assert.equal(parseQuietHours("9-17:45", at(17, 45)), false);
});

test("minute form on both sides ('22:30-06:45'), HH:MM style", () => {
  assert.equal(parseQuietHours("22:30-06:45", at(22, 30)), true);
  assert.equal(parseQuietHours("22:30-06:45", at(6, 44)), true);
  assert.equal(parseQuietHours("22:30-06:45", at(6, 45)), false);
  assert.equal(parseQuietHours("22:30-06:45", at(15, 0)), false);
});

test("same-day minute window ('12:15-12:45')", () => {
  assert.equal(parseQuietHours("12:15-12:45", at(12, 14)), false);
  assert.equal(parseQuietHours("12:15-12:45", at(12, 15)), true);
  assert.equal(parseQuietHours("12:15-12:45", at(12, 44)), true);
  assert.equal(parseQuietHours("12:15-12:45", at(12, 45)), false);
});

test("malformed specs disable quiet hours (return false)", () => {
  assert.equal(parseQuietHours("", at(23, 0)), false);
  assert.equal(parseQuietHours("nope", at(23, 0)), false);
  assert.equal(parseQuietHours("22", at(23, 0)), false);
  assert.equal(parseQuietHours("22-7-9", at(23, 0)), false);
  assert.equal(parseQuietHours("22:5-7", at(23, 0)), false); // single-digit minutes not a valid form
  assert.equal(parseQuietHours("22:99-7", at(23, 0)), false); // minutes out of range
  assert.equal(parseQuietHours("22-7:99", at(23, 0)), false);
});
