# github-core-clone-01 — a GitHub-compatible git forge

A standalone GitHub-compatible git forge in Node 22, standard library only, written for
[the contest](https://make.fun/bounty/github-core-clone-01). One process serves four surfaces
over a single in-memory store, so a mutation on any surface is visible on the others:

- **git smart HTTP** (`/<owner>/<repo>.git/...`): upload-pack protocol v2 (capability
  advertisement, ls-refs with peel/symrefs/unborn/ref-prefix, fetch with shallow/deepen and
  thin-pack/ofs-delta handling) with a v0 fallback, and receive-pack v0 (fast-forward only,
  report-status over sideband). Pack v2 read/write with OFS/REF delta resolution, no `git` binary.
- **REST v3** (`/api/v3/...`): repositories, branches, commits, contents, issues, comments,
  labels, pull requests, files, merges — every reply JSON with a non-empty
  `X-GitHub-Request-Id`; a wrong owner is 404, never 403; no token is 401.
- **GraphQL v4** (`POST /api/graphql`): a small recursive-descent parser for the documents `gh`
  and `github-mcp-server` send (variables, inline enums and input objects, aliases, inline
  fragments, batched arrays), `__type` introspection, cursor pagination, and the five mutations.
- **MCP** (`POST /mcp`): JSON-RPC 2.0 Streamable HTTP, `server/discover` (revision 2026-07-28)
  with a legacy `initialize` fallback, and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) over the same store.

Local conformance (the kit's sealed suite, `sdk/run.ts`): **120/120 checks pass — feature
600/600, agent-native 200/200, performance 166/200, total 966/1000** (push 38, clone 35, read 50,
write 45). The reference forge scores ~100/200 on performance.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only, and the trial
has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server and router (health probe, REST, GraphQL, MCP, git smart HTTP).
- `store.ts`: the shared in-memory store and the git object model (sha1, trees, commits, diffs,
  merge-base, three-way conflict detection, squash merges, contents commits). Server-created
  commits use a fixed identity and a monotonic counter timestamp, never the wall clock.
- `gitwire.ts`: pkt-lines, pack v2 read/write (with a deflated-bytes cache), upload-pack v2/v0,
  receive-pack v0, shallow/deepen fetch planning.
- `rest.ts`: REST v3 handlers.
- `graphql.ts`: GraphQL parser and resolvers.
- `mcp.ts`: MCP `server/discover`, `initialize`, `tools/list`, `tools/call`.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

This entry is MIT licensed.
