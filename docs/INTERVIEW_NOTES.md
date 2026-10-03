# workflow-hub — Interview Notes

A complete walkthrough of the project: what it is, how it works, why each decision was made,
and how to defend it in an interview. Everything here is grounded in the actual source.

---

## 0. The 60-second pitch

> **workflow-hub** is a real-time backend for team workspaces and tasks — the API behind a
> Trello/Jira-style product. It's Express 4 + MongoDB + Redis + Socket.io + JWT.
>
> The interesting part isn't the CRUD, it's the three things that are easy to get subtly wrong:
> **cursor pagination**, **refresh-token theft detection**, and **horizontal scaling**. Each of
> those I designed around a specific failure mode, and each one is backed by a measurement or a
> test rather than an assertion.
>
> It ships with 62 automated tests, a 32-assertion end-to-end smoke test that boots a real
> server, and a benchmark that proves the index design actually pays for itself — all runnable
> with zero infrastructure.

Three things to have ready to say, unprompted:
1. **Why keyset, not OFFSET** — and the subtle bug I hit doing it wrong.
2. **Refresh-token reuse detection** — rotation alone is security theatre.
3. **The shutdown bug** — a real production bug my tests *couldn't* see, and how I found it.

---

## 1. What the system does

A multi-tenant task backend. Users register, create **workspaces** (the tenant boundary), invite
members with roles, and manage **tasks** inside them. Tasks emit **real-time** events so every
connected client updates instantly. There's a **report** endpoint that aggregates per-assignee
workload, and an **activity log** audit trail.

| Layer | Tech | Why |
| --- | --- | --- |
| HTTP | Express 4 | Ecosystem maturity; 4.x is battle-tested with `middleware` error semantics |
| ODM | Mongoose 8 | Schema validation + `pre('save')` hooks + `.lean()` for fast reads |
| Database | MongoDB (Atlas) | Document model fits nested members/tasks; aggregation pipeline for reports |
| Cache / bus | Redis + ioredis | Rate limits, token store, report cache, Socket.io fan-out, presence |
| Real-time | Socket.io | Rooms + built-in reconnection + handshake middleware |
| Auth | JWT + HttpOnly cookies | Stateless verification, XSS-resistant storage |
| Validation | Zod | One schema per route, machine-readable errors |
| Logging | pino | Structured JSON, ~5x faster than winston, request-id correlation |
| Tests | Jest + supertest, mongodb-memory-server | No Docker, no local Mongo/Redis |

**Codebase scale:** 2,825 lines across 35 files in `src/` (2,920 including `server.js`), plus
1,887 lines of tests and tooling across 15 files.

---

## 2. Architecture and the request lifecycle

```
server.js
  └─ bootstrap()
       1. connectDb()        src/config/db.js      ← fails fast, exits 1
       2. connectRedis()     src/config/redis.js   ← falls back to memory substitute in dev
       3. createApp()        src/app.js           ← pure Express, no TCP listener
       4. http.createServer(app)
       5. initSockets(server) src/sockets/index.js
       6. server.listen()
       7. installShutdownHandlers()
```

The split at step 3 matters: `createApp()` returns the app **without binding a port or starting
Socket.io**. Tests mount it with supertest and get the full middleware chain with no TCP and no
sockets. `server.js` is the only file that touches the network.

### Middleware order in `src/app.js` — the order is the design

```
1. app.set('trust proxy', isProd ? 1 : false)   ← MUST be first
2. pino-http                                   ← request-id + structured logging
3. helmet() + crossOriginResourcePolicy
4. cors({ origin: allow-list, credentials: true })
5. express.json({ limit: '1mb' })              ← DoS guard
6. cookieParser()
7. express-mongo-sanitize()                    ← NoSQL injection
8. /api → rateLimit
9. routes
10. notFound → errorHandler                    ← MUST be last
```

Three orderings I can defend under questioning:

- **`trust proxy` first.** Rate limiting buckets on `req.ip`. If the proxy isn't trusted before
  anything reads the IP, every client behind the load balancer shares one bucket and you rate-limit
  the proxy. It's `1` (not `true`) in production — trusting `true` lets a client spoof
  `X-Forwarded-For` and evade its own limit.
- **Sanitize after body parsing, before routes.** `express-mongo-sanitize` mutates
  `req.body`/`req.query`/`req.params` in place, so it has to run after the body exists and before
  any handler reads it. This kills `?email[$ne]=null`.
- **Error handler last.** It's the only 4-arg middleware, and it's the single place that formats a
  response. Controllers never build error payloads.

---

## 3. Data model

```
User        email(unique) · name · passwordHash · avatarColor · isActive
Workspace   name · slug(unique) · owner · members[] { user, role, joinedAt } · archivedAt
Task        workspace · title · description · status · priority · assignee · createdBy
            dueDate · completedAt · labels[] · position
ActivityLog workspace · actor · action · entity · entityId · meta · createdAt(TTL)
```

`members[]` is **embedded**, not a join table. A workspace has a small, bounded, co-accessed
membership list — the classic case for embedding. It makes the RBAC check (`roleOf`) a single
document read with no join, and it makes the "workspaces I'm in" query one index hit.

Roles rank `member(1) < admin(2) < owner(3)`. The capability matrix is enforced by
`authorize(...roles)` middleware, not scattered through controllers.

**Two layers keep the password hash from leaking.** `passwordHash` is `select: false` on the
schema, so it isn't returned unless a query *explicitly* asks for it (only `login` does, via
`.select('+passwordHash')`). Then the `toJSON` transform deletes it anyway — defence in depth, so
a future query that accidentally selects it still can't serialize it to a client. There's a test
asserting the hash never appears in a register response.

**RBAC matrix:**

| Endpoint | Min role |
| --- | --- |
| `POST /workspaces`, `GET /workspaces` | any user |
| `GET /workspaces/:idOrSlug` | member |
| `PATCH /workspaces/:id` | admin, owner |
| `DELETE /workspaces/:id` | **owner only** |
| `GET .../members`, `.../activity`, `.../reports` | member |
| `POST/PATCH/DELETE .../members` | admin, owner |
| `GET/POST .../tasks`, `GET .../tasks/:id` | member |
| `PATCH/DELETE .../tasks/:taskId` | admin, owner |

**The 404-not-403 rule.** A non-member querying a workspace they aren't in gets **404, not 403**.
Returning 403 would confirm the workspace exists — an enumeration oracle. `authorize()` throws 404
for both "doesn't exist" and "you're not a member," so the two are indistinguishable from outside.

---

## 4. The four decisions worth your time

### 4.1 Keyset (seek) pagination, not OFFSET

`skip: 100000` makes MongoDB walk and discard 100,000 documents. Cost grows with page number, so
the user who scrolls deepest — the one paying most — gets the page they care least about. Worse,
OFFSET is offset against a *live* result set: a task created mid-scroll shifts every row after it,
so the same task appears on two pages and another is skipped.

A keyset cursor remembers the last document's sort key and continues from there. Every page is the
same O(log n) index seek, and concurrent inserts can't perturb the window.

**The bug that makes this worth talking about.** My first version encoded only `createdAt`. That was
correct for the default sort and **silently wrong** for `sort=dueDate` — two tasks sharing a due
date would be skipped or duplicated, because the continuation predicate no longer described the
actual sort. The fix (`src/utils/pagination.js`):

1. The cursor encodes **every field in the sort spec**, not just the primary one.
2. Every sort spec gets `_id` appended as a tie-breaker. Without a total order there is no
   well-defined "row after the cursor."
3. The cursor **records which sort produced it** and rejects a mismatch with
   `CURSOR_SORT_MISMATCH` rather than returning a plausible-but-wrong page.

The generated predicate, for `sort={createdAt:-1, _id:-1}`:

```js
{ $or: [
    { createdAt: { $lt: C } },
    { createdAt: C, _id: { $lt: I } }
]}
```

Each additional sort field extends the branches one at a time, so the predicate is always exactly
"documents sorting strictly after the cursor."

**Bonus:** `hasMore` is computed by fetching `limit + 1` rows — a free "is there a next page?"
probe that costs no extra query.

Cursor is base64url-encoded JSON carrying `{ s: sortKey, v: {field: value} }`. It's opaque to the
client but self-describing to the server.

### 4.2 Refresh tokens: single-use + reuse detection

JWTs are stateless, so a leaked refresh token is valid until it expires. Three Redis keys fix it:

```
rt:<jti>       →  { userId, familyId }    the ONE currently-valid token
rtf:<familyId> →  SET of every JTI ever issued in this family
rtu:<userId>   →  SET of familyIds (all of a user's live sessions)
```

**Why keep state when the JWT is self-contained?** Statelessness is only a feature while every
scenario you care about is "valid and unexpired." Logout, theft response, and rotation all need
server-side state, so I store the minimum: one key per live JTI plus a family index.

**Rotation:** refresh mints a new JTI, stores it, and deletes the old — but remembers the old JTI
in `rtf:`.

**Detection:** if a JTI arrives with *no* `rt:` record but *is* in `rtf:`, it was already rotated.
Someone is replaying a copy. That's theft → **revoke the entire family**, forcing a fresh login on
every device.

> **The line to say:** "Without reuse detection, rotation alone is security theatre. An attacker who
> steals a token and refreshes it first silently locks the real user out instead of raising an
> alarm. A detected theft is a contained theft."

**Details worth knowing:**
- Refresh tokens are stored **hashed with SHA-256**, so a leaked Redis dump can't be replayed
  against the API. SHA-256 (not bcrypt) is correct here because the input is already 256 bits of
  CSPRNG output — there's nothing to brute-force. Bcrypt is for low-entropy human passwords.
- Access (15m) and refresh (7d) use **separate secrets**, so a leaked access secret can't mint
  refresh tokens.
- `claimReuse`: on refresh, if the user is no longer active, `revokeAllForUser` fires.

### 4.3 Cookies *and* a bearer fallback

`HttpOnly` cookies mean an XSS bug **cannot read the session token** — the single biggest win of
cookie sessions. The cost is CSRF, handled by three layers:

1. `SameSite=strict` (default).
2. The refresh cookie is **path-scoped to `/api/v1/auth`** — it's never attached to ordinary API
   calls, so it can't ride along on a cross-site request to a data endpoint.
3. A CORS **allow-list**, never reflection.

The bearer fallback (`Authorization: Bearer …`) exists because tests, Postman, and non-browser
clients (mobile, CLI, server-to-server) need a transport without a cookie jar. Same verification
path, same expiry, same rotation.

**Login timing.** `login()` always runs a bcrypt compare, even for a nonexistent user, against a
fixed dummy hash. Otherwise a fast 401 for unknown-email vs. a slow 401 for wrong-password
enumerates your accounts through response latency.

### 4.4 Real-time: authenticate the *upgrade*

The Socket.io handshake is an HTTP request, and browsers send same-origin `HttpOnly` cookies with it
automatically. So auth happens **in the handshake**, before the socket is usable:

- A forged/expired token fails the upgrade. No socket ever exists that shouldn't.
- The token never touches client-side JavaScript.
- Not "connects, then fails later."

Rooms are `user:<userId>` and `ws:<workspaceId>`. Every socket auto-joins the workspaces the user
belongs to, so a fresh tab gets events without a subscribe round-trip.

**Membership is re-checked on every `workspace:subscribe`** — a token issued *before* someone was
removed must not keep streaming that workspace's data.

**Broadcasts happen after the DB write, never before.** Broadcasting first lets a client receive
`task:created`, immediately fetch it, and 404 because the write hasn't landed. (`smoke.js` asserts
exactly this: "broadcast task is already readable over HTTP".)

**`@socket.io/redis-adapter`** fans every publish out over Redis pub/sub, so an event emitted on
instance A reaches sockets on instance B. Without it, `io.to(room).emit()` only reaches local
sockets and the app is silently single-instance.

**Presence** is a Redis SET per workspace (`presence:ws:<id>`) with a 70s TTL heartbeat, so it
survives a process dying without a clean disconnect and stays correct across instances.

---

## 5. Index design (ESR) and the benchmark

**ESR = Equality, Sort, Range.** A compound index is a sorted list. Each equality prefix narrows it
to one contiguous range; the sort field is then already ordered; range predicates (`$gt`, `$lt`,
`$in`) can only bound keys *after* the sort field. If a range field precedes the sort field, the
index can no longer supply the ordering and MongoDB falls back to a blocking in-memory sort.

### Task indexes (`src/models/Task.js`)

| Index | Serves |
| --- | --- |
| `{ workspace, createdAt:-1, _id:-1 }` | default list + cursor paging |
| `{ workspace, status, dueDate, _id }` | board columns, `overdue=true` |
| `{ workspace, status, assignee }` | **the report** |
| `{ assignee, status, dueDate }` | "my open tasks" across workspaces |

### Workspace indexes

- `{ 'members.user': 1, updatedAt:-1, _id:-1 }` — "workspaces I'm in", dashboard order
- `{ owner: 1, createdAt:-1 }` — "workspaces I own"
- `unique(slug)` — public URL resolution

### The index I got wrong first

The report matches `workspace` (equality) + `status: {$in: ['todo','doing']}` then groups by
`assignee`. My first draft was `{workspace, assignee, status}`, reasoning that `assignee` should
follow the equality fields because `$group` needs documents in assignee order.

**Wrong on two counts.** The `$in` on `status` is a *filter* that then has to be applied after
seeking, rather than being part of the seek key — and group ordering is preserved regardless of
index order. Moving `status` before `assignee` gives one contiguous seek per requested status.
The planner agrees: the winning plan is `workspace_1_status_1_assignee_1`.

**Deliberately not indexed:** `title` (free text, anchored-prefix only), `labels` (low
cardinality, only ever filtered after `workspace`). Every index is a tax on every write *and* on
`syncIndexes`.

### Benchmark results

`npm run benchmark` drops the indexes, measures 20 runs, rebuilds, measures 20 more, and compares
`explain('executionStats')` over 100,000 tasks:

```
metric              WITHOUT index  WITH index                             improvement
avg latency (ms)    222.94         59.96                                  73.1% faster
docsExamined        100,000        3,402                                   96.6% fewer
keysExamined        0              3,404                                   index-only
winning plan        COLLSCAN       IXSCAN (workspace_1_status_1_assignee_1)  -
```

**The number to trust is `docsExamined`, not latency.** Across runs latency moved by more than 2×
while `docsExamined` held flat at a 96.6% reduction. Wall-clock is noisy; documents examined is
the causal quantity. Say that out loud — it's the mark of someone who has actually profiled.

Why the index reads 3,404 keys to return 3,402 rows: the compound index is ordered by
`(workspace, status, assignee)`, which is exactly the `$match` followed by the `$group`.

---

## 6. Rate limiting

Redis-backed, fixed-window, **fails open**.

```js
const totalHits = await redis.incr(key);
if (totalHits === 1) await redis.pexpire(key, windowMs);   // only the creating hit sets TTL
```

- **Why Redis, not in-memory:** with an in-process counter, N instances means N × the allowed rate,
  and the effective limit depends on which pod you hit.
- **Why fixed, not sliding:** re-arming the TTL on every hit creates a window a client can keep
  alive indefinitely by never pausing — a slow leak that eventually locks out a real user.
- **Why fails open:** if Redis errors, allow the request and log loudly. A rate-limiter outage
  taking down the whole API is a worse outcome than brief loss of throttling.
- **Auth is the exception** — there Redis failure should fail *closed*, because accepting an
  unverifiable session is worse than a 503.
- `/auth` gets its own bucket at **10 vs 300** (~30× stricter) — that's the brute-force surface.
- Bucket identity is `req.userId || req.ip` — authenticated users get per-user buckets, so one user
  behind a NAT doesn't burn their office's quota.

Emits standard `RateLimit-Limit/Remaining/Reset` + `Retry-After` on 429.

---

## 7. Caching the report

```js
$match  → workspace equality + status $in + assignee != null
$group  → one bucket per assignee: open / overdue / urgent
$lookup → join the user profile
$project→ trim to exactly what the client needs
```

Because the index yields documents already ordered by `assignee`, `$group` is **streaming** — no
hash spill to disk.

**Freshness strategy — two layers:**
- **Explicit invalidation** on every task mutation in that workspace (`invalidateWorkspaceReport`)
- **Short TTL (60s)** as the backstop for anything that slips through

**`$lookup` vs. denormalising the name:** `$lookup` keeps one source of truth and costs one index
probe *per grouped assignee*. Denormalising makes reads marginally cheaper but turns every profile
update into a fan-out across every task document and lets the two drift. I took the join and
bounded its cost by grouping first, so it's once per assignee, not once per task.

**Every cache operation degrades to a miss on error.** A cache must never be a hard dependency —
`cache.service.js` wraps every method in try/catch and returns `null`/`false`.

Pattern deletes use **`SCAN`, never `KEYS`** — `KEYS` blocks the Redis event loop on large datasets.

---

## 8. Error contract

Every failure has exactly one shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "email: Invalid email", "details": [], "requestId": "..." } }
```

`errorHandler` is the **only** place that formats a response, and it's the last middleware. It
translates Mongoose `ValidationError`, `CastError`, duplicate-key (`11000`), and JSON parse errors
into the contract. Controllers never know driver internals, and a validation failure can't produce
a different contract than a database failure.

**Codes are stable strings, not messages.** Clients switch on `code`; `message` is free to be
reworded. 5xx messages are replaced with a generic string in production so internals don't leak.

---

## 9. Horizontal scaling

**Nothing meaningful is process-local.** That is the whole design constraint:

| Concern | Where it lives |
| --- | --- |
| Rate-limit counters | Redis (shared bucket) |
| Refresh-token state | Redis (`rt:`/`rtf:`/`rtu:`) |
| Report cache | Redis |
| WebSocket fan-out | `@socket.io/redis-adapter` pub/sub |
| Presence | Redis SET + TTL |
| Sessions | Stateless JWT |

The API is stateless, so instances are interchangeable and **the load balancer needs no sticky
sessions**. The only process-local things are connections — which is exactly what you want.

`trust proxy` being enabled in production is what makes the rate-limit bucket real behind a proxy.

---

## 10. Testing: three layers, because one isn't enough

| Layer | Tool | Proves | **Cannot** prove |
| --- | --- | --- | --- |
| Integration | Jest + supertest | routes, services, validation, RBAC, cache, socket events | real sockets, process lifecycle, signals |
| End-to-end | `npm run smoke` | boot, HTTP, cookies, **real websockets**, broadcast-after-write, **graceful shutdown** | performance, multi-instance fan-out |
| Performance | `npm run benchmark` / `loadtest` | index effectiveness, latency under concurrency | correctness |

**The middle layer is not redundant — it caught a real bug.**

### The shutdown bug (best story in the project)

`server.close()` **only resolves once every connection is gone**, and an upgraded websocket never
goes away on its own. My first shutdown sequence awaited `server.close()` *before* disconnecting
sockets — so on **every deploy** with a live Socket.io client, shutdown hung for the full 10s hard
timeout.

This was invisible to **all 62 unit tests**, because `supertest` calls the Express app in-process:
no TCP accept, no init process, no signal delivery. The first smoke run flagged it immediately.

The correct order (`server.js:60-77`):

```js
const httpDrained = new Promise(resolve => server.close(resolve));  // 1. START the drain
await closeSockets();          // 2. disconnect websockets so connections actually close
server.closeIdleConnections?.();  // 3. drop idle keep-alives
await httpDrained;             // 4. NOW wait for the drain
await quitRedis();
await disconnectDb();
```

A hard `setTimeout(...).unref()` races the whole thing so a stuck connection can never block a
deploy forever. `uncaughtException` triggers the same path.

**The lesson to state:** "a suite that only tests handlers will never catch lifecycle bugs. That's
what the process-level test is for." Note also `scripts/lib/selfSignalServer.js` exists because
**Windows has no POSIX signals** — the smoke test can't send `SIGTERM` on win32.

### Coverage highlights
- **RBAC matrix** — every role × endpoint combination, plus cross-workspace isolation
- **Refresh rotation + reuse detection** — real theft scenario, family revocation asserted
- **NoSQL injection** — `?email[$ne]=null` neutralised
- **User enumeration** — unknown email and wrong password return identical messages *and* comparable timing
- **Cursor/sort interaction** — cross-sort replay rejected; pagination on a non-default sort never repeats or drops a row
- **Redis fan-out** — every broadcast goes through pub/sub (multi-instance readiness)
- **Rate limit** — enforcement, headers, per-identity buckets, window reset

`tests/globalSetup.js` starts one `mongodb-memory-server`; the suite runs with
`REDIS_IN_MEMORY=true`, so **no Docker, no local Mongo, no local Redis**. That matters: a suite
requiring `docker compose up` is a suite people skip.

### The in-process Redis substitute

`src/config/memoryRedis.js` (~300 lines) implements the command surface this codebase uses —
including `MULTI`/`EXEC`, `SCAN`, and pattern pub/sub with ioredis's exact `messageBuffer`/
`pSubscribe` casing — over a `Map`. `duplicate()` returns a second client over the *same* keyspace,
exactly like a second TCP connection, which is what the Socket.io adapter needs for its subscriber.

It is **not** a Redis replacement: single-process, no persistence, no scripting. Dev-only fallback
with a loud warning; production throws.

**And it earned its keep immediately** — two bugs it surfaced were real production-path bugs:
- `INCR` didn't preserve the key's existing TTL. Redis does.
- `MULTI`/`EXEC` returned unresolved promises; the limiter read `[0][1]` and got `NaN`. Exactly the
  silent breakage a hand-rolled mock invites.

---

## 11. Deployment

**Dockerfile** — three-stage build:
1. `deps` — full install (build anything) → cached
2. `prod` — `npm ci --omit=dev`, no compilers → small image
3. `runner` — copies prod `node_modules` + source

Plus: `dumb-init` as ENTRYPOINT (PID 1 swallows signals — without it the graceful handler never
runs), non-root `app` user, `HEALTHCHECK` on `/health/ready` (readiness, not liveness, so
Compose gates traffic on real dependency health).

**`docker-compose.yml`** brings up `app` + `mongo` + `redis` with health-gated startup. On
`SIGTERM` the sequence is: stop accepting → close websockets → release Redis → release Mongo.

**Liveness vs. readiness:**
- `/health` — process is up
- `/health/ready` — 200 **only** when Mongo *and* Redis are both connected; 503 otherwise, so an
  orchestrator stops routing traffic to a degraded instance

---

## 12. Honest limitations

Volunteering these is the highest-leverage thing in the whole interview. If you only list strengths,
an experienced interviewer assumes you haven't found the edges.

- **No soft delete on tasks.** Hard delete + `ActivityLog` entry means the audit trail references
  an id that no longer resolves.
- **No password-change endpoint.** `revokeAllForUser` exists and is wired to account deactivation,
  but there's no flow that triggers it on a credential change.
- **Activity log is TTL'd** (`expireAt`, `expireAfterSeconds: 0`) and append-only — an
  operational trail, not a compliance record. The feed is `limit`-bounded rather than cursor-paged,
  so deep scrolling isn't supported.
- **No websocket rate limiting** — only the HTTP handshake is limited. A connected client can emit
  events freely.
- **Cross-workspace isolation is application-level**, not database-level. A bug in a shared filter
  could leak across tenants; per-workspace database filtering would be the defence in depth.
- **Benchmark is single-node.** It proves the index, not the fleet. Multi-instance fan-out is
  asserted by a test, not measured under load.
- **No refresh-token reuse detection across a password change** — same gap as above.
- **Rate limiting is fixed-window**, so a client can burst 2× the limit across a window boundary.
  A sliding window or token bucket is stricter if that matters.

**Where I'd go next, in order:** per-workspace DB filtering → password-change flow with
`revokeAllForUser` → websocket rate limiting → materialized report once the collection outgrows
live aggregation.

---

## 13. Interview Q&A

**Why keyset over OFFSET?**
OFFSET makes the server walk and discard every skipped row, so page 100 costs 100× page 1, and the
row set shifts under the user when anything is inserted. A keyset cursor seeks directly on an
index, costs the same on every page, and is stable against concurrent writes. It costs more
complexity — and the cursor must encode the entire sort key or it's subtly wrong. I found that the
hard way.

**Why store token state in Redis if the JWT is self-contained?**
To make tokens *revocable* and *single-use*. Statelessness is only a feature while every scenario
is "valid and unexpired." Logout, theft response and rotation all need server-side state, so I
store the minimum — one key per live JTI plus a family index.

**How do you detect a stolen refresh token?**
Single-use rotation. Each refresh mints a new JTI and deletes the old, remembering the old JTI in a
per-family set. A JTI that's known but no longer live was already rotated, so it's a replay: revoke
the whole family, force fresh login everywhere. Without this, an attacker who refreshes first
silently locks the real user out instead of raising an alarm.

**Why a CORS allow-list instead of reflecting `Origin`?**
Reflecting whatever arrives with `credentials: true` is equivalent to allowing every origin — any
site can then make authenticated requests with the victim's cookies. The list is explicit and the
check is server-side regardless of what the browser enforces.

**Why not an in-memory rate-limit counter?**
The limit has to be global. In-process means N instances gives N × the rate, and the effective limit
depends on which pod you hit.

**Why does the rate limiter fail open?**
Availability beats throttling. If the counter store is down, rejecting everything turns a degraded
dependency into a full outage. I log it loudly and let traffic through. Auth is the exception —
there Redis failing should fail closed, since accepting an unverifiable session is worse than a 503.

**What is ESR and when doesn't it apply?**
Equality fields first, then Sort, then Range. A compound index is a sorted list; each equality
prefix narrows to one contiguous range, the sort field is then already ordered, and range
predicates can only bound keys *after* the sort field — put a range field before the sort field and
the index can no longer supply the order. It doesn't apply to unindexed queries, and isn't
sufficient alone: a `COLLSCAN` in `explain` means the index is missing a field the query filters on.

**How did you decide which indexes to create?**
From access patterns, not from the schema. Every index in `models/Task.js` names the endpoint it
serves. Then I measured — the benchmark runs the report with and without indexes and compares
`docsExamined`, so the claim is checkable rather than asserted. Anything not backing a real query
(`title`, `labels`) is deliberately unindexed; every index is a per-write tax.

**`$lookup` or a denormalised field?**
`$lookup` keeps one source of truth and is one index probe per grouped assignee. Denormalising the
name makes reads marginally cheaper but turns every profile update into a fan-out across every task
document and lets the two drift. I took the join and bounded its cost by grouping first — once per
assignee, not once per task.

**How do you stop the report cache serving stale data?**
Short TTL plus explicit invalidation on every task mutation in the workspace. The TTL is the
backstop; the invalidation makes a change visible immediately. The cache read is wrapped so any
Redis failure degrades to a miss — a cache must never be a hard dependency.

**How does this scale to multiple instances?**
Nothing is process-local. Rate limits and token state in Redis, report cache in Redis, websocket
fan-out through the Redis adapter, presence a Redis set. The API is stateless, so instances are
interchangeable and the LB needs no sticky sessions. The only process-local things are connections.

**What happens on shutdown?**
`SIGTERM` stops the HTTP listener so in-flight requests drain, closes websockets, then releases
Redis and Mongo in dependency order, with a hard timeout so a stuck connection can't block a deploy
forever. `dumb-init` forwards the signal because PID 1 swallows signals by default. The ordering
was wrong at first — `server.close()` only resolves once *every* connection is gone, and an upgraded
websocket never goes away on its own, so awaiting it before disconnecting sockets hung for the full
10s timeout on any deploy with a live client. Exactly the class of bug `supertest` can't see.

**What's the hardest bug you hit?**
(Use the shutdown bug, then the cursor/sort mismatch — both have a "how did you find it" story,
which is the part they actually care about.)

---

## 14. Demo script (if they ask to see it live)

```bash
npm test                 # 62 tests, no infra
npm run smoke            # boots a real server, 32 assertions
npm run seed -- --tasks=5000
npm run benchmark        # index vs no-index
npm run dev              # then: curl localhost:4000/health/ready
```

**Don't demo against Atlas first** — if the network blips, you'll debug live. Use the in-memory
path, or `docker compose up --build` if Docker is available.

Seeded logins: `user1@seed.local` … `user50@seed.local`, password `SeedPassword123!`.

**The 30-second API demo:** register → create workspace → create task → open a second client on the
same workspace → watch `task:created` arrive live → show the report endpoint's `cached: true` on the
second read. That last beat demonstrates caching + invalidation in one move.

---

## 15. Files worth opening live during the interview

| If they ask about | Open |
| --- | --- |
| Pagination | `src/utils/pagination.js` (cursor encode/decode + `CURSOR_SORT_MISMATCH`) |
| Index design | `src/models/Task.js` (the ESR comment block) |
| Token security | `src/services/auth.service.js` (key layout + reuse detection) |
| Middleware order | `src/app.js` |
| The shutdown bug | `server.js:60-77` |
| Report pipeline | `src/services/report.service.js` |
| Why fail-open | `src/middleware/rateLimit.js:83-87` |
| Rate limiting | `src/middleware/rateLimit.js:35-42` (fixed-window TTL) |
| Handshake auth | `src/sockets/handlers.js:34-63` |

---

## 16. One-page cheat sheet

```
STACK       Express 4 · Mongoose 8 · MongoDB · Redis/ioredis · Socket.io · JWT · Zod · pino
SCALE       2,825 LOC in src/ (35 files) + 1,887 LOC tests/tools (15 files)
TESTS       62 Jest (5 suites) + 32 smoke assertions + benchmark + loadtest
KEY NUMBERS docsExamined 100,000 → 3,402 (96.6% fewer) · latency 73% faster · COLLSCAN → IXSCAN

ARCH        bootstrap → connectDb → connectRedis → createApp(no port) → http → sockets → listen

4 DECISIONS
 1. Keyset cursor encodes the FULL sort + _id tiebreak; cross-sort replay → CURSOR_SORT_MISMATCH
 2. Refresh tokens single-use; rotated-JTI replay = theft → revoke whole family
 3. HttpOnly cookies (XSS-proof) + path-scoped refresh cookie (CSRF) + bearer fallback
 4. Auth in the websocket HANDSHAKE; rooms re-checked per subscribe; broadcast AFTER the write

INDEXES     Task: 4 compound (workspace+createdAt, workspace+status+dueDate,
                          workspace+status+assignee [report], assignee+status+dueDate)
            Workspace: members.user+updatedAt, owner+createdAt, unique(slug)
            NOT indexed: title (free text), labels (low cardinality)

SCALING     Zero process-local state → stateless API → no sticky sessions.
            Rate limits + tokens + cache + presence + pub/sub all in Redis.

GOTCHAS     trust proxy must be FIRST (rate-limit buckets on req.ip)
            sanitize AFTER body parse, BEFORE routes
            error handler LAST (single response contract)
            404 not 403 for non-members (no enumeration oracle)
            login always bcrypts (no timing-based user enumeration)
            SCAN not KEYS (KEYS blocks the event loop)
            fixed-window: only the creating hit sets the TTL
            fail OPEN on rate-limit Redis; fail CLOSED on auth Redis

BUG STORY   shutdown awaited server.close() before disconnecting sockets → hung 10s on every
            deploy with a live client. Invisible to all 62 unit tests; supertest never opens a
            socket. Caught by the smoke test on first run.

LIMITATIONS no soft delete · no password-change flow · no ws rate limiting ·
            app-level (not DB-level) tenant isolation · fixed-window burst edge ·
            benchmark is single-node
```