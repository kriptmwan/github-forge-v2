# github-forge-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, speed-optimized rebuild (v2): smart HTTP, REST v3, GraphQL v4 and MCP — built from scratch in TypeScript (Node 22 standard library only, no dependencies, no git binary) for the make.fun github-core-clone-01 bounty.

This is v2 of the v1 forge (which scored 600/600 feature + 200/200 agent on the server). Same wire formats, same conformance surface, same determinism rules — plus hot-path caches aimed at the four timed workloads:

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 advertisements (now a prebuilt constant buffer), `ls-refs`, `fetch` (plain objects, no deltas; shallow / deepen / deepen-relative), and v0 `receive-pack` with fast-forward enforcement, per-ref `ok` / `ng <ref> non-fast-forward` reporting. Packfiles are built and parsed by hand (SHA-1, zlib, OFS/REF deltas).
  - Fetch responses are cached whole, keyed by the canonical fetch arguments; objects are immutable and wants are content-addressed OIDs, so a cached pack stays valid — and a fetch is only cached when every OID it names already exists in the store. The 50 concurrent shallow clones of the clone workload send identical fetch requests: 1 pack build + 49 cache hits.
  - v0 advertisements and `ls-refs` answers are cached per repo, keyed by a fingerprint of the live ref set, so any ref move misses the cache and can never serve a stale answer.
- **REST v3** (`/api/v3`): repositories, branches, commits, git refs, contents (create/update/delete with blob-SHA optimistic concurrency), labels, issues, comments, pull requests (three-way merge-base diffs, squash merge) — JSON only, `X-GitHub-Request-Id` on every reply.
  - GET issue answers come from a pre-serialized per-issue Buffer cache (versioned; PATCH/comment/close bumps the version and drops the entry). The read workload hits the same issue 2,000 times: 1 serialization + 1,999 cache hits.
  - The request URL is parsed once per request and the expected bearer token is read once at startup.
- **GraphQL** (`/api/graphql`): viewer, repository / issue / pullRequest connections with cursor pagination, `__type` introspection for the suite's documents, create/close issue, create/merge pull request, add comment, batched operation bodies.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, `server/discover` (revision 2026-07-28) plus the `initialize` handshake, 8 tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`, `create_pull_request`, `list_pull_requests`, `merge_pull_request`) acting on the same store as REST.

Determinism: no `Date.now()` or `Math.random()` on request paths — timestamps come from `MAKEFUN_TRIAL_NOW` (parsed once at module load; it is constant for a trial), the viewer identity is derived from the trial seed, and ids are sequential counters, so two runs produce identical exports.

## Run it

```sh
npm start
```

Requires Node >= 22.18. The entry point (`main.ts`) binds a port, registers it with the environment at `$MAKEFUN_ENV_URL`, then polls `/done` until the trial finishes. Environment variables:

- `MAKEFUN_ENV_URL` — the trial environment's base URL (required)
- `MAKEFUN_SHOP_TOKEN` — the bearer token the forge accepts (when set, exactly this token; otherwise any non-empty bearer)
- `MAKEFUN_TRIAL_NOW` — RFC 3339 timestamp used for all created/updated times
- `MAKEFUN_TRIAL_SEED` — trial seed (viewer identity is derived from the fixed scenario seed)

## Layout

- `main.ts` — lifecycle only (bind → register → poll `/done` → exit)
- `app.ts` — HTTP server, routing, all REST handlers
- `store.ts` — in-memory store: git objects (SHA-1, pack read/write, trees, commits), repos, issues, PRs, squash merge; trial clock + issue JSON cache
- `git.ts` — git smart HTTP: pkt-lines, v0/v2 advertisements, ls-refs, fetch, receive-pack; fetch/advertisement caches
- `graphql.ts` — hand-written GraphQL tokenizer, parser and executor
- `mcp.ts` — MCP endpoint: discover/initialize, tools/list, tools/call

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
