// Shared inter-agent delegation contract for FRIDAY/TUESDAY/CLARA — formalizes what was
// previously an unauthenticated, contract-drifted, ad hoc HTTP call (CLARA's friday-bridge.ts)
// or a slow one-way file drop with no confirmation (TUESDAY's Drive handoff). The three apps
// stay otherwise isolated (separate repos, separate deploys, separate data stores) — this module
// is just the shared vocabulary + auth for the handful of calls that cross between them.

export type InteragentCaller = "friday" | "tuesday" | "clara";

export type InteragentKind = "chat" | "draft" | "code" | "seo" | "research" | "handoff";

export interface InteragentRequest {
  from: InteragentCaller;
  kind: InteragentKind;
  /** Free-text ask (chat/draft/code/seo/research kinds). */
  prompt?: string;
  /** Drive file id being handed off (handoff kind) — lets the receiver process just that file
   *  instead of re-scanning a whole folder. */
  driveFileId?: string;
  /** Receiver-side client id, when the caller already knows which client this concerns. */
  clientId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface InteragentResponse {
  ok: boolean;
  /** Which endpoint/path actually served the request, for caller-side logging. */
  via: string;
  reply?: string;
  /** Id of a tracked task/run the receiver created for this request, if any (e.g. FRIDAY minting
   *  a Task from a TUESDAY handoff) — the caller's confirmation-of-receipt. */
  taskId?: string;
  error?: string;
}

const HEADER = "x-interagent-secret";

/**
 * Marker header that an app's perimeter host-gate middleware sets AFTER it has cryptographically
 * verified a Cloudflare Access assertion (signature + `aud` + `iss` against the team JWKS). It is
 * the ONLY trustworthy signal that a request was Access-authenticated at the edge.
 *
 * SECURITY CONTRACT — the middleware that sets this MUST, on EVERY request:
 *   1. delete/strip any client-supplied copy of this header, and
 *   2. set it (to "1") ONLY after the Cf-Access-Jwt-Assertion JWT verifies.
 *
 * This module deliberately does NOT read the raw `Cf-Access-Jwt-Assertion` header: its mere
 * presence is forgeable by any caller, which was exactly the pre-2026-09 bypass. Trust flows only
 * through this middleware-controlled marker. (JWKS verification lives at the perimeter, not here,
 * so this shared check stays synchronous — no `await` in the ~20 route handlers that call it.)
 */
export const ACCESS_VERIFIED_HEADER = "x-agent-access-verified";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Strips the port and any IPv6 brackets, then tests against the loopback set. */
function isLoopbackHost(raw: string | null): boolean {
  if (!raw) return false;
  const host = raw.trim().toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * True when a request already proved its identity through a boundary STRONGER than the shared
 * secret, so an owner/human request should not additionally need a static string meant for
 * sibling agents:
 *
 *   - It never left the machine: Host (and X-Forwarded-Host, if present) are both loopback. All
 *     three agents bind 127.0.0.1, so a request with Host=127.0.0.1 cannot have arrived from
 *     outside. Requiring BOTH headers loopback-or-absent is the fail-closed direction (a proxy may
 *     preserve Host while signalling the real origin via X-Forwarded-Host).
 *   - Cloudflare Access authenticated a real human at the edge AND the app's perimeter middleware
 *     cryptographically verified that assertion and stamped `ACCESS_VERIFIED_HEADER` (see its
 *     contract above). We trust that middleware-set marker — never the raw, forgeable
 *     `Cf-Access-Jwt-Assertion` header.
 */
function isAlreadyTrusted(req: Request): boolean {
  const host = req.headers.get("host");
  const forwarded = req.headers.get("x-forwarded-host");
  if (isLoopbackHost(host) && (forwarded === null || isLoopbackHost(forwarded))) return true;
  return req.headers.get(ACCESS_VERIFIED_HEADER) === "1";
}

/** Header to attach on an outbound inter-agent call. Omits the header (rather than sending an
 *  empty one) when no shared secret is configured, so local dev without INTERAGENT_SHARED_SECRET
 *  set still works — the receiver's own check treats a missing configured secret as "auth off". */
export function interagentAuthHeaders(): Record<string, string> {
  const secret = process.env.INTERAGENT_SHARED_SECRET?.trim();
  return secret ? { [HEADER]: secret } : {};
}

/**
 * Verify an inbound inter-agent call. Returns true when any of:
 *   (a) no INTERAGENT_SHARED_SECRET is configured on this receiver (auth intentionally off — e.g.
 *       local dev),
 *   (b) the request's `x-interagent-secret` header matches the configured secret, or
 *   (c) the request already cleared a stronger boundary — loopback, or Access-verified at the
 *       perimeter (see `isAlreadyTrusted`).
 *
 * (c) exists because of a real incident: on 2026-08-04, FRIDAY's own web chat 401'd on every
 * message once INTERAGENT_SHARED_SECRET was set, because a browser's own fetch never attaches this
 * header. A caller that already proved it is the owner (loopback, or Access) should not
 * additionally need a static string meant for OTHER AGENTS. Crucially, the Access half of (c) now
 * trusts only the middleware-verified `ACCESS_VERIFIED_HEADER` marker — not the raw, forgeable
 * `Cf-Access-Jwt-Assertion` header, which previously let any caller bearing that header name bypass
 * this check.
 *
 * Does NOT verify against a specific `from` claim — the header/marker identifies the trust
 * boundary, not a per-agent identity; the `from` field in the body is caller-attribution for
 * logging, not an identity check.
 */
export function verifyInteragentSecret(req: Request): boolean {
  const secret = process.env.INTERAGENT_SHARED_SECRET?.trim();
  if (!secret) return true;
  if (req.headers.get(HEADER) === secret) return true;
  return isAlreadyTrusted(req);
}
