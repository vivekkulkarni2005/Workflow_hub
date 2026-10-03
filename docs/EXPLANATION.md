# workflow-hub — design notes

Everything below is a decision that had a real alternative. Where a trade-off exists, the reasoning
and the cost of being wrong are stated.

---

## 1. Why the cursor is a keyset cursor, not `OFFSET`

`skip: 100000` makes MongoDB walk and discard 100,000 documents on every page. The cost of page *N*
is proportional to *N*, so a user scrolling to the bottom of a large task list pays the most for the
page they care about least. Worse, `OFFSET` is offset against a live result set: a task created while
someone is scrolling shifts every subsequent row, and the same document appears on two pages.

A keyset ("seek") cursor remembers the last document's sort key and continues with
`createdAt < c OR (createdAt = c AND _id < id)`. Every page is the same O(log n) index seek, and
inserts cannot perturb the window.

The subtlety that makes this correct rather than nearly-correct: **the cursor must mirror the full
sort specification.** An early version of this code encoded only `createdAt`, which was fine for the
default sort and silently wrong for `sort=dueDate` — two tasks with the same due date would be
skipped or repeated. `src/utils/pagination.js` now takes the sort spec, encodes every field in it,
and rejects a cursor that belongs to a different sort (`CURSOR_SORT_MISMATCH`) instead of returning
a plausible but wrong page.

Every sort spec also ends with `_id` as a tie-breaker. Without a total order there is no well-defined
"row after the cursor".

## 2. Index design: ESR, and why the report index is `{workspace, status, assignee}`

Compound indexes should be ordered **E**quality, **S**ort, **R**ange. Fields you filter on with
equality come first (each equality collapses the index to a single contiguous range), then the field
you sort by (so the index supplies the ordering), then range predicates.

The report endpoint (`src/services/report.service.js`) matches on `workspace` (equality) and
`status: {$in: ['todo','doing']}` (a small bounded set of key ranges) and then groups by `assignee`.

The first draft indexed `{workspace, assignee, status}`, reasoning that `assignee` should follow the
equality fields because the `$group` needs documents in assignee order. That is wrong on two counts:
the `$in` on `status` is a *filter* that then has to be applied after seeking, rather than being part
of the seek key, and the group ordering is preserved regardless. Moving `status` before `assignee`
gives one contiguous seek per requested status. The benchmark's winning plan confirms the planner
prefers `workspace_1_status_1_assignee_1`.

The other three task indexes each back a specific access pattern, documented in `src/models/Task.js`:

| Index | Access pattern |
| --- | --- |
| `{workspace, createdAt:-1, _id:-1}` | default list + cursor paging |
| `{workspace, status, dueDate, _id}` | board columns, `overdue=true` |
| `{workspace, status, assignee}` | the report |
| `{assignee, status, dueDate}` | "my open tasks" across workspaces |

Deliberately **not** indexed: `title` (free text, anchored-prefix only), `labels` (low cardinality and
only ever filtered after `workspace`). Each index is a tax on every write and on `syncIndexes`.

**The benchmark exists to check this reasoning rather than assert it.** It drops the indexes, measures,
rebuilds them, measures again, and reports `docsExamined` from `explain('executionStats')`: 100,000
→ 3,402 documents, 96.6 % fewer. Latency dropped 73.1 % on the recorded run; across runs the ratio
held between 63 % and 75 % while the absolute numbers moved by more than 2×, which is why
`docsExamined` is the number to trust. If someone later reorders the index wrong, it moves.

## 3. Refresh tokens: single-use with reuse detection

JWTs are stateless, which is convenient and also means a leaked refresh token is valid until it
expires. The design here makes each refresh token single-use:

```
rt:<jti>       -> { userId, familyId }   the one currently valid token
rtf:<familyId> -> SET of every jti ever issued in this family
rtu:<userId>   -> SET of familyIds (the user's live sessions)
```

On refresh: verify signature, load `rt:<jti>`, mint a new JTI, delete the old key. If a JTI is
presented that *is* in `rtf:` but no longer has an `rt:` record, it was already rotated — so someone
is replaying a copy. That is treated as theft and the entire family is revoked, forcing a fresh login
on every device.

Without reuse detection, rotation alone is security theatre: an attacker who steals a token and
refreshes it first silently locks the real user out instead of raising an alarm.

## 4. Why cookies *and* a bearer fallback

`HttpOnly` cookies mean an XSS bug cannot read the session token — the single biggest advantage of
cookie sessions. They also mean CSRF becomes the concern, which is why `SameSite=strict` is the
default and why the refresh cookie is additionally path-scoped to `/api/v1/auth`: it is never
attached to ordinary API calls, so it cannot ride along on a cross-site request to a data endpoint.

The bearer fallback (`Authorization: Bearer …`) exists because the test suite, the Postman
collection and non-browser clients (mobile, CLI, server-to-server) all need a token transport that
does not involve cookie jars. Same verification path, same expiry, same rotation.

## 5. The rate limiter is Redis-backed, fixed-window, and fails open

`express-rate-limit`'s default store keeps counters in process, which is useless the moment there is
more than one instance: a user behind N pods gets N × the limit. The counter therefore lives in Redis.

**Fixed window, not sliding.** Only the request that *creates* the counter may set the TTL:

```js
const totalHits = await redis.incr(key);
if (totalHits === 1) await redis.pexpire(key, windowMs);
```

Re-arming the TTL on every hit would turn this into a sliding window that a client could keep alive
indefinitely by never pausing — a slow leak that eventually locks out a legitimate heavy user.

**It fails open.** If Redis errors, the request is allowed through and the failure is logged. A
rate-limiter outage taking the whole API down is a worse outcome than a brief loss of throttling.
Contrast with the auth path, where Redis failure *should* fail closed: a broken token store is not
something to shrug off.

`/auth` gets its own bucket at ~30 × the global limit, because that is the brute-force surface.

## 6. Real-time: authenticate the upgrade, scope by room

The Socket.io handshake is an HTTP request, and browsers send same-origin `HttpOnly` cookies with it
automatically. Authenticating there means the *upgrade itself* is refused for an unauthenticated
peer — no socket ever exists that should not, and the token never touches client-side JavaScript.
A forged or expired token fails the handshake rather than connecting "and then failing later".

Every socket auto-joins `user:<userId>` and `ws:<workspaceId>` for each workspace it belongs to.
Membership is re-checked on every explicit `workspace:subscribe`, because a token issued before
someone was removed from a workspace must not keep streaming its data.

Broadcasts happen **after** the database write, never before. Broadcasting first would let a client
receive a task event, fetch it, and 404 because the write had not landed.

`@socket.io/redis-adapter` fans messages out through Redis pub/sub, so a broadcast from one instance
reaches sockets connected to all of them. Presence is a Redis set with a TTL rather than in-process
state, for the same reason.

## 7. The in-process Redis substitute

`src/config/memoryRedis.js` implements the small command surface this codebase uses — including
`MULTI`/`EXEC`, `SCAN` and pattern pub/sub with ioredis's `messageBuffer`/`pSubscribe` casing — over a
`Map`. `duplicate()` returns a second client over the *same* keyspace, exactly like a second TCP
connection, which is what the Socket.io adapter needs for its subscriber connection.

It exists so `npm test` needs nothing installed. That is worth a fair amount: a suite that requires
`docker compose up` first is a suite people skip.

It is **not** a Redis replacement. It is single-process (so it cannot test cross-instance behaviour),
it has no persistence, and it deliberately does not implement scripting. In development only, the app
falls back to it when Redis is unreachable, with a loud warning; in production it throws.

Two bugs this substitute surfaced early, both of which were real bugs in the production path too:

- `INCR` was not preserving the key's existing TTL. Redis does; the substitute did not.
- `MULTI`/`EXEC` returned unresolved promises. The limiter read `[0][1]` and got `NaN`, which is
  exactly the kind of silent breakage a hand-rolled mock invites.

## 8. Errors: one shape, one place

Every error reaching the client has the same shape:

```json
{ "error": { "code": "MACHINE_READABLE_CODE", "message": "human sentence", "details": [] } }
```

`AppError` carries an HTTP status and a stable code; `errorHandler` is the only place that formats a
response, and it is the last middleware. Mongoose and Zod errors are translated there rather than in
controllers, so a validation failure and a database failure can never produce two different
contracts. Codes are stable strings, not messages — clients should switch on `code`, and the message
is free to be reworded.

## 9. What the app does *not* do

Worth being explicit about, since these are the obvious next questions:

- **No refresh-token reuse across a password change** — `revokeAllForUser` exists and is called when
  an account is deactivated, but there is no password-change endpoint yet.
- **No soft delete on tasks.** Deleting is a hard delete with an `ActivityLog` entry, so the audit
  trail references an id that no longer resolves.
- **No multi-workspace broadcast in one event.** A task event is scoped to its own workspace room.
- **The activity log is append-only with a TTL index**, so it is an operational audit trail, not a
  compliance record.
- **No rate limiting on websockets**, only on the HTTP handshake.

---

## Interview questions and answers

**Why keyset pagination over `OFFSET`?**
`OFFSET` makes the server walk and discard every skipped row, so page 100 costs 100× page 1, and the
row set shifts under the user when anything is inserted. A keyset cursor seeks directly on an index,
costs the same on every page, and is stable against concurrent writes. It costs a little more
complexity, and the cursor must encode the entire sort key or it is subtly wrong.

**Why store refresh-token state in Redis if the JWT is self-contained?**
Because I want tokens to be *revocable* and *single-use*. Statelessness is only a feature while every
scenario you care about is "is this token valid and unexpired". Logout, theft response and rotation
all need server-side state, so I store just enough (one key per live JTI plus a family index) to get
it.

**How do you detect a stolen refresh token?**
Refresh tokens are single-use. Each refresh mints a new JTI and deletes the old key, but remembers the
old JTI in a per-family set. If a JTI arrives that is known but no longer live, it was already
rotated, so it is a replay: revoke the entire family and force a fresh login everywhere. A theft
that is detected is a theft that is contained; the alternative is the attacker silently locking the
legitimate user out.

**Why a CORS allow-list instead of a reflection of `Origin`?**
Reflecting whatever origin arrives with `credentials: true` is equivalent to allowing every origin —
any site can then make authenticated requests with the victim's cookies. The list is explicit, and
the check runs server-side regardless of what the browser enforces.

**Why not store the rate-limit counter in memory?**
Because the limit has to be global. With an in-process counter, N instances means N × the allowed
request rate, and a load balancer makes the effective limit depend on which pod you happened to hit.

**Why does the rate limiter fail open?**
Availability beats throttling. If the counter store is down, rejecting every request turns a
degraded dependency into a full outage. I log it loudly and let traffic through. Auth is the
exception — there Redis failing should fail closed, because accepting an unverifiable session is
worse than a 503.

**What is the ESR rule and when does it not apply?**
Equality fields first, then Sort, then Range. A compound index is a sorted list; each equality prefix
narrows it to one contiguous range, the sort field is then already ordered, and range predicates
(`$gt`, `$lt`, `$in`) can only bound keys that come *after* the sort field. If a range field precedes
the sort field, the sort can no longer be satisfied by index order. It does not apply to unindexed
queries, obviously, nor is it sufficient by itself — a `COLLSCAN` in `explain` means the index is
missing a field the query actually filters on.

**How did you decide which indexes to create?**
From the access patterns, not from the schema. Every index in `src/models/Task.js` names the endpoint
it serves. I then measured: the benchmark runs the report query with and without the indexes and
compares `docsExamined` and latency, so the claim is checkable rather than asserted. Anything not
backing a real query (`title`, `labels`) is deliberately unindexed — every index is a per-write tax.

**`$lookup` vs. a denormalised field?**
`$lookup` keeps a single source of truth for the user name and is one index probe per grouped
assignee. Denormalising the name onto the task makes report reads marginally cheaper but makes every
profile update a fan-out across every task document, and lets the two drift. I chose the join and
bounded its cost by grouping first, so the lookup runs once per assignee rather than once per task.

**How do you keep the report cache from serving stale data?**
Short TTL (60 s) plus explicit invalidation on every task mutation in the workspace. The TTL is the
backstop; the invalidation is what makes a change visible immediately. The cache read is wrapped so
any Redis failure degrades to a miss rather than an error — a cache must never be a hard dependency.

**How does this scale to multiple instances?**
Nothing is process-local. Rate-limit counters and refresh-token state are in Redis; report caching is
in Redis; websocket fan-out goes through the Redis adapter; presence is a Redis set with a TTL. The
API is stateless, so instances are interchangeable and a load balancer needs no sticky sessions.
The only process-local things are connections, which is exactly what you want.

**What happens on shutdown?**
`SIGTERM` stops the HTTP listener so in-flight requests drain, closes websockets, then releases Redis
and Mongo in dependency order — with a hard timeout so a stuck connection cannot block a deploy
forever. `dumb-init` in the image forwards the signal to Node, because the init process is PID 1 and
swallows signals by default.

The ordering here was wrong at first and the end-to-end smoke test caught it. `server.close()` only
resolves once *every* connection is gone, and an upgraded websocket never goes away on its own, so
awaiting it before disconnecting sockets made shutdown hang for the full 10 s timeout on any deploy
with a live client. The correct order is: start the drain (do not await), disconnect sockets, drop
idle keep-alive connections, *then* await the drain. This is exactly the class of bug `supertest`
cannot see, because it never opens a real socket.

## 10. Testing strategy: three layers

| Layer | Tool | What it can prove | What it cannot |
| --- | --- | --- | --- |
| Unit / integration | `jest` + `supertest` | routes, services, validation, RBAC, cache logic, socket events | real sockets, real process lifecycle, real signals |
| End-to-end | `npm run smoke` | boot, HTTP, cookies, websockets, broadcast-after-write, graceful shutdown | performance, multi-instance fan-out |
| Performance | `npm run benchmark` / `loadtest` | index effectiveness, latency under concurrency | correctness |

The middle layer is not redundant. `supertest` calls the Express app in-process, so it exercises the
handler chain and nothing below it — no TCP accept, no `dumb-init`, no signal delivery. The shutdown
bug above was invisible to all 62 unit tests and obvious to the first smoke run.

**Where would you go next?**
Virtualised per-workspace database filtering, a real password-change flow with `revokeAllForUser`,
websocket rate limiting, and a materialized report if the collection outgrows live aggregation.
