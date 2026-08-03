// Shared CLI subprocess runner — extracted from FRIDAY's/TUESDAY's/CLARA's near-identical
// runner.ts (TUESDAY's header called itself "adapted from FRIDAY's"; CLARA's called itself a
// "trimmed port"). Deliberately does NOT own binary resolution or the per-app AgentName union —
// those diverged for real reasons (CLARA auto-detects via `which`; FRIDAY/TUESDAY read a
// pre-resolved config object; the engine sets themselves differ). Each app keeps its own
// `binFor(agent): string` and calls these with an already-resolved binary path.
//
// Uses cross-spawn rather than node:child_process's spawn() directly: on Windows, an
// npm-installed CLI's resolved binary is often a .cmd wrapper, and plain spawn() throws EINVAL
// launching a .cmd/.bat file without shell:true — a well-known Node/Windows gap. Naively passing
// shell:true would be a real shell-injection risk (these apps pass LLM prompts as CLI args, and
// cmd.exe's quoting rules are exploitable). cross-spawn solves exactly this: it detects when the
// target needs the Windows command shell and escapes every argument for cmd.exe's parser, so args
// can't break out into a second command — same safety as plain spawn(), but works with .cmd/.bat.

import crossSpawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
export const HOME_DIR = os.homedir();

// Vars every app strips because they're host-session markers injected when this app is itself
// launched from inside another Claude Code / agent host — ANTHROPIC_BASE_URL points at a
// host-scoped proxy and CLAUDECODE/CLAUDE_CODE_*/SDK markers make a spawned `claude -p` think
// it's a nested SDK session, both causing 401s against the user's own `claude login`.
const COMMON_HOST_ENV_DENYLIST = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDECODE",
  "CLAUDE_EFFORT",
];
const COMMON_HOST_ENV_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_FLOW_"];

const COMMON_PATH_DIRS_WIN = (home: string, base: NodeJS.ProcessEnv) => [
  path.join(base.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm"),
  path.join(home, ".local", "bin"),
  "C:\\Program Files\\nodejs",
];
const COMMON_PATH_DIRS_POSIX = (home: string) => [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  path.join(home, ".local", "bin"),
];

export interface AgentEnvOptions {
  /** Explicit per-call overrides — applied last, after all sanitization. */
  extra?: Record<string, string>;
  /** Additional PATH dirs beyond the common base (e.g. FRIDAY's kimi-code/Python Scripts dirs). */
  extraPathDirs?: string[];
  /** Additional host/session vars to strip beyond COMMON_HOST_ENV_DENYLIST (e.g. TUESDAY strips
   *  ANTHROPIC_API_KEY too, since it's a fallback-only credential for its direct-HTTP engine that
   *  must not leak into the spawned `claude` CLI). */
  extraHostDenylist?: string[];
  /** env var name that, when "1", skips host-session stripping entirely (per-app opt-out). */
  keepHostEnvFlag?: string;
  /** Vars stripped unconditionally, even when keepHostEnvFlag is set (FRIDAY's own deploy/infra
   *  secrets — a spawned CLI must never inherit them regardless of the debug opt-out). */
  alwaysStripDenylist?: string[];
}

export function agentEnv(opts: AgentEnvOptions = {}): NodeJS.ProcessEnv {
  const base = process.env;
  const sep = IS_WIN ? ";" : ":";
  const commonDirs = IS_WIN ? COMMON_PATH_DIRS_WIN(HOME_DIR, base) : COMMON_PATH_DIRS_POSIX(HOME_DIR);
  const ensurePath = [...commonDirs, ...(opts.extraPathDirs ?? [])];
  const existing = (base.PATH ?? base.Path ?? "").split(sep).filter(Boolean);
  const merged = [...new Set([...existing, ...ensurePath])].join(sep);

  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: merged,
    HOME: base.HOME || HOME_DIR,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  for (const key of opts.alwaysStripDenylist ?? []) delete env[key];

  const keepHost = opts.keepHostEnvFlag && process.env[opts.keepHostEnvFlag] === "1";
  if (!keepHost) {
    const denylist = [...COMMON_HOST_ENV_DENYLIST, ...(opts.extraHostDenylist ?? [])];
    for (const key of Object.keys(env)) {
      if (denylist.includes(key) || COMMON_HOST_ENV_PREFIXES.some((p) => key.startsWith(p))) {
        delete env[key];
      }
    }
  }

  Object.assign(env, opts.extra ?? {}); // explicit per-call env wins over sanitization
  if (!IS_WIN) env.SHELL = base.SHELL || "/bin/zsh";
  return env;
}

const FLAG_PATTERN = /^[A-Za-z0-9_\-./:=,@+%]+$/;
export const MAX_ARG_LEN = 32_000;

export function validateFlagArgs(args: readonly string[]): string[] {
  return args.filter((a) => typeof a === "string" && a.length < MAX_ARG_LEN && FLAG_PATTERN.test(a));
}

export function safeArg(a: unknown): string | null {
  if (typeof a !== "string") return null;
  if (a.length === 0 || a.length > MAX_ARG_LEN) return null;
  if (a.includes("\0")) return null;
  return a;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  input?: string;
  extraEnv?: Record<string, string>;
  onChunk?: (text: string) => void;
  envOptions?: Omit<AgentEnvOptions, "extra">;
}

/** @param bin Already-resolved binary path — callers own binary resolution (see module header). */
export async function runProcess(bin: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const cleanArgs = args.map(safeArg).filter((a): a is string => a !== null);
  const started = Date.now();

  return new Promise<RunResult>((resolve) => {
    const child = crossSpawn(bin, cleanArgs, {
      cwd: opts.cwd ?? HOME_DIR,
      env: agentEnv({ ...opts.envOptions, extra: opts.extraEnv ?? {} }),
      // These apps run as console-less background services — without this, every CLI child gets
      // a brand-new console that Windows Terminal shows on screen for the child's whole runtime.
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, opts.timeoutMs ?? 15_000);

    child.stdout.on("data", (b) => { const s = b.toString(); stdout += s; opts.onChunk?.(s); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => { clearTimeout(timeout); resolve({ ok: code === 0, code, stdout, stderr, durationMs: Date.now() - started }); });
    child.on("error", (e) => { clearTimeout(timeout); resolve({ ok: false, code: -1, stdout, stderr: String(e), durationMs: Date.now() - started }); });

    if (opts.input) child.stdin.write(opts.input);
    try { child.stdin.end(); } catch {}
  });
}

export interface SpawnOptions {
  cwd?: string;
  input?: string;
  extraEnv?: Record<string, string>;
  envOptions?: Omit<AgentEnvOptions, "extra">;
}

/** @param bin Already-resolved binary path — callers own binary resolution (see module header). */
export function spawnProcess(bin: string, args: readonly string[], opts: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  const cleanArgs = args.map(safeArg).filter((a): a is string => a !== null);
  const child = crossSpawn(bin, cleanArgs, {
    cwd: opts.cwd ?? HOME_DIR,
    env: agentEnv({ ...opts.envOptions, extra: opts.extraEnv ?? {} }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true, // console-less service — never surface a terminal window for CLI children
  }) as ChildProcessWithoutNullStreams;
  if (typeof opts.input === "string" && opts.input.length > 0) child.stdin.write(opts.input);
  try { child.stdin.end(); } catch {}
  return child;
}
