// Shared a8l-os (Autom8ion Lab OS) authentication — structurally ported from CLARA's
// google-auth.ts token-cache pattern (file-backed refresh token, in-memory access-token cache
// with a 60s pre-expiry margin), generalized into a factory since each app needs its own config
// (agent directory, redirect URI) rather than CLARA's single-app global-singleton shape.
//
// Auth flow: Supabase's own `/auth/v1/authorize?provider=google` hands the OAuth dance to
// Supabase + Google, then redirects back with the session in a URL FRAGMENT (fragments never
// reach the server) — so the actual token capture happens client-side on a small "capture" page
// that POSTs the tokens to this module's callback handler. See each app's
// src/app/api/os/auth/{route.ts,callback/route.ts} + src/app/os/auth/capture/page.tsx.
//
// Refresh tokens ROTATE on every use (unlike Google's) — the new one from each refresh response
// MUST be persisted, or the next refresh fails. A single in-flight refresh promise is shared by
// concurrent callers so two near-simultaneous refreshes can't race each other into invalidating
// the token the other is about to use.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface OsAuthConfig {
  /** Directory this agent's session file lives in, e.g. ~/.agentic-os/friday */
  agentDir: string;
  /** Falls back to process.env.OS_SUPABASE_URL — no built-in default. Must resolve to a real
   *  Supabase project or the constructor throws. */
  supabaseUrl?: string;
  /** Falls back to process.env.OS_SUPABASE_ANON_KEY — no built-in default. Must resolve to a real
   *  anon key or the constructor throws. */
  supabaseAnonKey?: string;
  /** This app's own capture-page URL Supabase should redirect back to. */
  redirectUri: string;
}

interface SessionStore {
  refresh_token?: string;
  email?: string;
}

interface AccessCacheEntry {
  token: string;
  exp: number;
}

export class OsAuth {
  private readonly agentDir: string;
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly redirectUri: string;
  private readonly storePath: string;
  private cached: AccessCacheEntry | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(cfg: OsAuthConfig) {
    this.agentDir = cfg.agentDir;

    const supabaseUrl = cfg.supabaseUrl ?? process.env.OS_SUPABASE_URL;
    if (!supabaseUrl) {
      throw new Error(
        "OsAuth: no Supabase URL configured. Set OS_SUPABASE_URL (or pass supabaseUrl in " +
          "OsAuthConfig) to your own Supabase project — this library ships no default project " +
          "so a misconfigured app can't silently point at someone else's production instance."
      );
    }
    const anonKey = cfg.supabaseAnonKey ?? process.env.OS_SUPABASE_ANON_KEY;
    if (!anonKey) {
      throw new Error(
        "OsAuth: no Supabase anon key configured. Set OS_SUPABASE_ANON_KEY (or pass " +
          "supabaseAnonKey in OsAuthConfig)."
      );
    }

    this.supabaseUrl = supabaseUrl.replace(/\/$/, "");
    this.anonKey = anonKey;
    this.redirectUri = cfg.redirectUri;
    this.storePath = path.join(this.agentDir, "os-session.json");
    if (!existsSync(this.agentDir)) mkdirSync(this.agentDir, { recursive: true });
  }

  private readStore(): SessionStore {
    try {
      return JSON.parse(readFileSync(this.storePath, "utf8")) as SessionStore;
    } catch {
      return {};
    }
  }

  private writeStore(s: SessionStore): void {
    writeFileSync(this.storePath, JSON.stringify(s, null, 2));
  }

  /** Where to send the browser to start the one-time interactive Google sign-in via Supabase. */
  consentUrl(): string {
    const p = new URLSearchParams({ provider: "google", redirect_to: this.redirectUri });
    return `${this.supabaseUrl}/auth/v1/authorize?${p.toString()}`;
  }

  osConfigured(): boolean {
    return Boolean(this.readStore().refresh_token);
  }

  osIdentity(): { email?: string } {
    return { email: this.readStore().email };
  }

  /**
   * Called by this app's POST /api/os/auth/callback once the client-side capture page has
   * extracted {access_token, refresh_token} from the redirect's URL fragment. Verifies the
   * identity via Supabase's own /auth/v1/user before persisting, so a malformed/foreign token
   * can't silently get stored as this agent's session.
   */
  async captureSession(accessToken: string, refreshToken: string): Promise<{ ok: boolean; email?: string; error?: string }> {
    const r = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: this.anonKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return { ok: false, error: `identity check ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
    const j = (await r.json()) as { email?: string };
    if (!j.email) return { ok: false, error: "no email on verified session — refusing to store" };

    this.writeStore({ refresh_token: refreshToken, email: j.email });
    this.cached = null;
    return { ok: true, email: j.email };
  }

  /** Fresh, non-expired access token — from cache, or a rotation-safe refresh. */
  async getFreshOsJwt(): Promise<string> {
    if (this.cached && Date.now() < this.cached.exp - 60_000) return this.cached.token;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<string> {
    const rt = this.readStore().refresh_token;
    if (!rt) throw new Error("a8l-os not connected — visit /os/auth to sign in");

    const r = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: this.anonKey },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!r.ok) {
      throw new Error(`a8l-os token refresh ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    }
    const j = (await r.json()) as { access_token: string; refresh_token: string; expires_in?: number };

    // Refresh tokens ROTATE on every use — persist the new one or the NEXT refresh 400s.
    const s = this.readStore();
    s.refresh_token = j.refresh_token;
    this.writeStore(s);

    this.cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }
}
