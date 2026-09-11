// Tests for verifyInteragentSecret's trust boundaries.
//
// The Cloudflare-Access path trusts ONLY the middleware-set ACCESS_VERIFIED_HEADER — the marker a
// perimeter middleware stamps AFTER cryptographically verifying the Access JWT and stripping any
// client copy. It does NOT trust the raw, forgeable `Cf-Access-Jwt-Assertion` header (that was the
// pre-2026-09 bypass). These tests pin that: a raw/forged Access header is REJECTED; the verified
// marker is accepted; loopback and shared-secret paths are unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyInteragentSecret, ACCESS_VERIFIED_HEADER } from "./index";

const SECRET = "s3cret-value";
function req(headers: Record<string, string>): Request {
  return new Request("http://ignored.invalid/", { headers });
}

test("no secret configured: auth intentionally off, passes", () => {
  delete process.env.INTERAGENT_SHARED_SECRET;
  assert.equal(verifyInteragentSecret(req({})), true);
  assert.equal(verifyInteragentSecret(req({ host: "friday.autom8ionlab.com" })), true);
});

test("secret configured, matching x-interagent-secret header: passes", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    assert.equal(
      verifyInteragentSecret(req({ "x-interagent-secret": SECRET, host: "friday.autom8ionlab.com" })),
      true,
    );
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("secret configured, non-loopback, no secret / wrong secret, no marker: fails closed", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    // The real cross-agent-over-the-tunnel case with no proof must still require the secret.
    assert.equal(
      verifyInteragentSecret(req({ host: "friday.autom8ionlab.com" })),
      false,
      "a plain tunnel request with no secret and no verified marker must be rejected",
    );
    assert.equal(
      verifyInteragentSecret(req({ "x-interagent-secret": "wrong", host: "friday.autom8ionlab.com" })),
      false,
    );
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("loopback host: trusted without the secret (owner's own browser / local calls)", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    // IPv6 loopback is bracketed in a Host header ("[::1]:port"); a bare "::1" is not a valid
    // Host form and is intentionally not parsed as loopback.
    for (const host of ["127.0.0.1:3737", "127.0.0.1", "localhost:3000", "localhost", "[::1]:8080"]) {
      assert.equal(verifyInteragentSecret(req({ host })), true, `loopback host "${host}" should be trusted`);
    }
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("loopback Host but non-loopback X-Forwarded-Host: fails closed", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    assert.equal(
      verifyInteragentSecret(req({ host: "127.0.0.1:3737", "x-forwarded-host": "attacker.example.com" })),
      false,
      "a spoofed X-Forwarded-Host must not be treated as loopback",
    );
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("VULN FIX: raw / forged Cf-Access-Jwt-Assertion header is NO LONGER trusted", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    // Pre-fix, presence of this header returned true regardless of value — the bypass. It must not.
    assert.equal(
      verifyInteragentSecret(req({ host: "friday.autom8ionlab.com", "cf-access-jwt-assertion": "some.jwt.value" })),
      false,
      "mere presence of the raw Access header must not grant trust — it is client-forgeable",
    );
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});

test("Access-verified marker (set by a verifying perimeter middleware): passes; bogus value: fails", () => {
  process.env.INTERAGENT_SHARED_SECRET = SECRET;
  try {
    assert.equal(
      verifyInteragentSecret(req({ host: "friday.autom8ionlab.com", [ACCESS_VERIFIED_HEADER]: "1" })),
      true,
      "a request the perimeter middleware verified + marked must be trusted",
    );
    assert.equal(
      verifyInteragentSecret(req({ host: "friday.autom8ionlab.com", [ACCESS_VERIFIED_HEADER]: "0" })),
      false,
      "a non-'1' marker value must not be trusted",
    );
  } finally { delete process.env.INTERAGENT_SHARED_SECRET; }
});
