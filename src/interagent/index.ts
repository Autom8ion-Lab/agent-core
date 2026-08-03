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

/** Header to attach on an outbound inter-agent call. Omits the header (rather than sending an
 *  empty one) when no shared secret is configured, so local dev without INTERAGENT_SHARED_SECRET
 *  set still works — the receiver's own check treats a missing configured secret as "auth off". */
export function interagentAuthHeaders(): Record<string, string> {
  const secret = process.env.INTERAGENT_SHARED_SECRET?.trim();
  return secret ? { [HEADER]: secret } : {};
}

/**
 * Verify an inbound inter-agent call. Returns true when either (a) no INTERAGENT_SHARED_SECRET is
 * configured on this receiver (auth intentionally off — e.g. local dev), or (b) the request's
 * header matches it. Does NOT verify against a specific `from` claim — the header alone identifies
 * "this came from one of my sibling agents on the same machine," which is the actual trust
 * boundary here (all three bind to 127.0.0.1); the `from` field in the body is caller-attribution
 * for logging, not an identity check.
 */
export function verifyInteragentSecret(req: Request): boolean {
  const secret = process.env.INTERAGENT_SHARED_SECRET?.trim();
  if (!secret) return true;
  return req.headers.get(HEADER) === secret;
}
