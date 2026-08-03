# agent-core (teaching edition)

`@autom8ionlab/agent-core` is the shared library behind **FRIDAY**, **TUESDAY**, and **CLARA** —
three separate AI agent apps that each need to authenticate to, and act inside, a central CRM
("a8l-os") as their own distinct, RLS-scoped identity.

This is **not** a runtime app you deploy on its own. It's a library each agent's own app imports,
extracted from the real, previously-duplicated code paths that all three apps used to carry
independently. It's published here as teaching material for the Autom8ion Lab open-source series —
a worked example of how a small fleet of independent agent apps can share an auth/MCP-client layer
without merging into a monolith.

## What's in it

| Module | Purpose |
| --- | --- |
| `osauth` | Authenticates an agent app to the central CRM's Supabase project as its own user — Google OAuth via Supabase, rotation-safe refresh-token handling, in-memory access-token caching. |
| `osmcp` | A native MCP client for the CRM's MCP server, plus the **per-app tool allowlists** (`FRIDAY_OS_TOOLS`, `TUESDAY_OS_TOOLS`, `CLARA_OS_TOOLS`) that scope exactly which of the ~470 registered tools each agent may call — the primary department-scoping boundary, not just defense-in-depth. |
| `interagent` | The shared delegation contract the three agents use to hand work to each other (chat/draft/code/seo/research/handoff), replacing what used to be ad hoc, unauthenticated HTTP calls between them. |
| `notify` / `notify-policy` | The one genuinely pure, identical-across-apps piece of each app's notification logic — quiet-hours parsing and the emergency/timely/normal escalation ladder. Actual delivery and dedupe stay app-specific by design. |
| `engines` | The shared, pure piece of "parse a model's JSON reply out of markdown fences/prose" — dispatch and failover-chain logic stays per-app. |
| `store` | A dependency-free, local-first JSON document store with atomic (Windows-hardened) writes and an optional cross-process advisory lock, extracted from FRIDAY's and TUESDAY's near-identical persistence layers. |
| `ostasks` | The shared agent-side runtime for the CRM's pull-based "Agent Tasks" scheduling: poll for due work, dispatch to a registered handler, report the outcome back (shadow-mode aware). |
| `runner` | A shared CLI subprocess runner (built on `cross-spawn` for safe `.cmd`/`.bat` handling on Windows) used to launch each app's underlying coding-agent CLI. |
| `embeddings` | A tiny LM-Studio-backed embeddings helper, callers supply their own base URL and model. |
| `ui` | A couple of small shared React components/hooks (e.g. sidebar navigation) used across the three apps' dashboards. |

Each module's own doc comments explain **why** it was extracted and, just as importantly, why
certain adjacent logic was deliberately *not* unified (see `notify`, `notify-policy`, and `engines`
in particular — divergent behavior across apps is sometimes the correct design, not an oversight).

## Setup

This is a plain library, not a runtime app — nothing to run here directly. Each consuming app
(`friday`, `tuesday`, `clara`) depends on it via a local `file:../agent-core` path in its
`package.json`, so clone this repo as a **sibling folder** named `agent-core` alongside them:

```
some-folder/
├── agent-core/   (this repo)
├── friday/
├── tuesday/
└── clara/
```

## Configuration

This library ships with **no default/production credentials**. Every consuming app must provide
its own Supabase project URL and anon key, either via `OsAuthConfig` or the `OS_SUPABASE_URL` /
`OS_SUPABASE_ANON_KEY` environment variables — `OsAuth`'s constructor throws a clear error if
neither is set, rather than silently falling back to someone else's live project.

## Status

This is a library snapshot prepared specifically for public/teaching release: names and comments
have been reviewed to remove real phone numbers, production credentials, and other
non-public specifics. It is not kept in sync with the private, production version of
`agent-core` and is not intended to be installed as-is into a production system.

## License

MIT — see [LICENSE](./LICENSE).
