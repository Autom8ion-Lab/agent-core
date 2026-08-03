// Native MCP client for a8l-os's mcp-server (localhost:3100/mcp, 470 tools). Used for
// deterministic, backend-driven CRM calls — as opposed to the CLI-tool-source wiring in each
// app's runner.ts/engines.ts, which is for ad hoc access during a dispatched Claude Code run.
//
// The MCP SDK's StreamableHTTPClientTransport snapshots `requestInit.headers` at CONSTRUCTION
// time, not per-request. A long-lived client reusing one transport would silently keep sending
// whatever JWT was current when it was built, including an expired one. So every call here opens
// a fresh connection with a freshly-minted token, calls once, and closes — no long-lived session.
// This costs a connection/session handshake per call; that's the correct tradeoff for a
// correctness-over-latency integration like this one.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OsAuth } from "../osauth/index.js";

export interface OsMcpConfig {
  auth: OsAuth;
  /** Defaults to the local a8l-os mcp-server. */
  url?: string;
  /** Client-side allow-list, defense-in-depth on top of server-side RLS. Exact tool names or
   *  "prefix_*" patterns — MCP `--allowedTools`-style prefix wildcards are NOT reliable inside
   *  the CLI, but a plain string-prefix check here is fine since we own the matching logic. */
  allow?: (toolName: string) => boolean;
  clientName?: string;
}

const DEFAULT_URL = "http://127.0.0.1:3100/mcp";

export class OsMcpClient {
  constructor(private readonly cfg: OsMcpConfig) {}

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const jwt = await this.cfg.auth.getFreshOsJwt();
    const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url ?? DEFAULT_URL), {
      requestInit: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const client = new Client({ name: this.cfg.clientName ?? "agent-core-osmcp", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async listTools(): Promise<string[]> {
    return this.withClient(async (client) => {
      const res = await client.listTools();
      return res.tools.map((t) => t.name);
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.cfg.allow && !this.cfg.allow(name)) {
      throw new Error(`osmcp: "${name}" is not in this agent's allow-list — refused client-side`);
    }
    return this.withClient(async (client) => {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) {
        const text = Array.isArray(res.content) ? res.content.map((c) => ("text" in c ? c.text : "")).join(" ") : "";
        throw new Error(`osmcp: tool "${name}" failed: ${text.slice(0, 300)}`);
      }
      return res.content;
    });
  }
}

/** Prefix-list allow predicate — matches "foo_*" (any tool starting with "foo_") or an exact name. */
export function allowByPrefixes(prefixes: string[]): (toolName: string) => boolean {
  return (toolName) =>
    prefixes.some((p) => (p.endsWith("_*") ? toolName.startsWith(p.slice(0, -1)) : toolName === p));
}

export * from "./allowlists";
