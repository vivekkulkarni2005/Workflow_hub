# workflow-hub

Real-time backend for team workspaces and tasks: **Express 4 + Mongoose + Redis + Socket.io + JWT**.

- REST API with cursor pagination, filtering, Zod validation and role-based access control
- Cookie-based JWT sessions with refresh rotation and theft (reuse) detection
- Real-time task events over Socket.io, authenticated at the HTTP upgrade, fanned out across instances through Redis pub/sub
- Report aggregation (`$match` → `$group` → `$lookup` → `$project`) with ESR-ordered compound indexes and Redis caching
- Redis-backed rate limiting, Helmet, CORS allow-list, NoSQL-injection sanitisation, structured logs, graceful shutdown
- 62 automated tests plus a 32-assertion end-to-end smoke test, none of which need Docker, a local MongoDB or a local Redis
- A 100,000-task benchmark that proves the index actually pays for itself

---

## Quick start

### One command (Docker)

```bash
docker compose up --build
```

Brings up `app` + `mongo` + `redis` with health-gated startup. API on <http://localhost:4000>.

To seed demo data into the compose MongoDB:

```bash
docker compose exec app node scripts/seed.js
```

### Without Docker

You need Node >= 20 and a MongoDB + Redis reachable on the default ports.

```bash
npm install
cp .env.example .env       # then set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET
npm run dev
```

`npm run dev` also starts without Redis: in development the app falls back to an in-process Redis
substitute and logs a warning. It never does that in production or test.

### With MongoDB Atlas

No Atlas CLI, driver or code change is needed — the app talks to Atlas through the same
`MONGODB_URI`. Do this once in the Atlas UI:

1. **Create the Project.** Everything in Atlas lives under an **Organization** → **Project**, and the
   cluster you are about to create has to belong to one. In the left sidebar pick your organization
   from the top-left dropdown, then *Projects* → *Create Project* (or just go straight to
   *Create* → *New Cluster* and type the project name into the first field — the wizard creates it
   for you). Name it e.g. `workflow-hub`. Skip the additional settings and the
   "add team members" screen if you are working solo.
2. **Create a cluster inside that project.** *Create* → pick the free **M0** tier, a cloud provider
   and region near you. The default is fine. Deployment finishes in ~1 minute.
3. **Create a database user.** *Database Access* → *Add New Database User*.
   - Authentication method: **Password**.
   - Username: e.g. `workflowhub`. Password: generate one with the *Autogenerate Secure Password*
     button and **copy it now** — Atlas shows it only once.
   - Database User Privileges → *Add`@atlas` as`?`*: pick the **Read and write to any database**
     role. (The `?` is the **Add Atlas Internal Access Role** toggle — leave it **off**.)
4. **Add your IP to the access list.** *Network Access* → *Add IP Address* → *Allow access from
   anywhere* (`0.0.0.0/0`) for convenience, or *Add my current IP address* to lock it to your
   machine. Atlas blocks everything not on this list, and that is the single most common
   "it just times out" cause. Wait for the entry to show as **Active**.
5. **Copy the connection string.** *Database* → the cluster → *Connect* → *Drivers* →
   **Node.js** → copy the URI. Set the driver version and copy the string shown.

It looks like this:

```
mongodb+srv://workflowhub:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=workflow-hub
```

6. **Put it in `.env`**, as the database name in the path (this project uses `workflow-hub`):

```bash
MONGODB_URI=mongodb+srv://workflowhub:<password>@cluster0.abcde.mongodb.net/workflow-hub?retryWrites=true&w=majority&appName=workflow-hub
```

Encode the password if it contains `@ : / ? # [ ] %` — those are URI delimiters. Easiest fix is to
generate a password containing only letters and digits.

7. **Verify:**

```bash
npm run dev
curl http://localhost:4000/health/ready
```

A `"mongodb": "connected"` in the payload and HTTP 200 mean it worked. In development Mongoose
builds the indexes itself (`autoIndex` is on outside production), so the first start also creates the
compound indexes the reports rely on — expect a short pause while the free tier provisions them.

To seed demo data into Atlas:

```bash
npm run seed -- --tasks=5000
```

`npm run seed` defaults to 100,000 tasks, which is slow and wasteful on an M0 free tier (32 GB
storage cap) — keep the count small. The logins are `user1@seed.local` … `user50@seed.local`, password
`SeedPassword123!`.

### Verify

```bash
curl http://localhost:4000/health          # liveness
curl http://localhost:4000/health/ready    # 200 only when mongo + redis are both up
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Production start (`node server.js`). |
| `npm run dev` | Same, with nodemon reload. |
| `npm test` | Full Jest suite (62 tests, no infrastructure needed). |
| `npm run seed` | Bulk-inserts 20 workspaces, 50 users, 100,000 tasks. |
| `npm run benchmark` | Runs the report query with and without indexes and prints the numbers. |
| `npm run loadtest` | autocannon load test with p50/p90/p99. |
| `npm run smoke` | End-to-end check: boots a real server and drives the whole flow over HTTP + a websocket. |

Both `seed` and `benchmark` connect to `MONGODB_URI` if a server is listening there, and otherwise
start a throwaway in-memory `mongod`, so they work on a bare machine.

Useful flags:

```bash
npm run seed -- --tasks=250000 --workspaces=40 --users=100 --batch=10000
npm run benchmark -- --runs=50 --tasks=100000
npm run loadtest -- --login --connections=100 --duration=30
```

Seeded logins: `user1@seed.local` … `user50@seed.local`, password `SeedPassword123!`.

---

## API

All routes are under `/api/v1`. Auth is `HttpOnly` cookie (`wf_access`) with a bearer-token fallback.
The refresh cookie `wf_refresh` is scoped to `/api/v1/auth` so it is never sent with ordinary API calls.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | `{ name, email, password }` → 201 + session cookies |
| POST | `/api/v1/auth/login` | `{ email, password }` |
| POST | `/api/v1/auth/refresh` | Rotates the refresh token; detects reuse |
| POST | `/api/v1/auth/logout` | 204, revokes the whole token family |
| GET | `/api/v1/auth/me` | Current user |

### Workspaces

| Method | Path | Min. role |
| --- | --- | --- |
| POST | `/api/v1/workspaces` | any user |
| GET | `/api/v1/workspaces` | any user (cursor paginated) |
| GET | `/api/v1/workspaces/:idOrSlug` | member |
| PATCH | `/api/v1/workspaces/:workspaceId` | admin, owner |
| DELETE | `/api/v1/workspaces/:workspaceId` | owner |
| GET | `/api/v1/workspaces/:workspaceId/members` | member |
| POST | `/api/v1/workspaces/:workspaceId/members` | admin, owner |
| PATCH | `/api/v1/workspaces/:workspaceId/members/:userId` | admin, owner |
| DELETE | `/api/v1/workspaces/:workspaceId/members/:userId` | admin, owner |
| GET | `/api/v1/workspaces/:workspaceId/activity` | member |
| GET | `/api/v1/workspaces/:workspaceId/reports` | member (Redis cached) |

### Tasks

| Method | Path | Min. role |
| --- | --- | --- |
| GET | `/api/v1/workspaces/:id/tasks` | member |
| POST | `/api/v1/workspaces/:id/tasks` | member |
| GET | `/api/v1/workspaces/:id/tasks/:taskId` | member |
| PATCH | `/api/v1/workspaces/:id/tasks/:taskId` | admin, owner |
| DELETE | `/api/v1/workspaces/:id/tasks/:taskId` | admin, owner |

List query parameters: `status` (repeatable), `priority` (repeatable), `assignee` (`me` /
`unassigned` / `<userId>`), `overdue`, `q` (anchored title prefix), `sort`
(`createdAt` | `dueDate` | `priority` | `status`), `limit`, `cursor`.

```bash
curl "http://localhost:4000/api/v1/workspaces/$WS/tasks?status=todo&status=doing&assignee=me&sort=dueDate&limit=20" \
     -H "Authorization: Bearer $TOKEN"
```

### Error shape

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "email: Invalid email", "details": [] } }
```

| Status | Meaning |
| --- | --- |
| 400 | Bad request, malformed cursor |
| 401 | Missing / invalid / expired credentials |
| 403 | Authenticated but not permitted |
| 404 | Not found, or hidden because you are not a member |
| 409 | Conflict (e.g. email taken) |
| 422 | Zod validation failure |
| 429 | Rate limited (`Retry-After` + `RateLimit-*` headers) |
| 503 | Dependency down (readiness) |

---

## Real-time

Connect to the same origin; the `HttpOnly` access cookie authenticates the HTTP upgrade, so no token
is ever exposed to client-side JavaScript.

```js
const socket = io();                       // cookie is sent automatically
socket.on('task:created', ({ task }) => …); // scoped to ws:<workspaceId> rooms
socket.on('task:updated', ({ task }) => …);
socket.on('task:deleted', ({ taskId }) => …);
socket.on('presence:state', ({ workspaceId, online }) => …);

socket.emit('workspace:subscribe', { workspaceId }, (ack) => …);
socket.emit('presence:list', workspaceId);
```

| Event | Direction | Payload |
| --- | --- | --- |
| `task:created` / `task:updated` / `task:deleted` | server → room | task or id |
| `workspace:updated` / `workspace:deleted` | server → room | workspace or id |
| `presence:joined` / `presence:left` / `presence:state` | server → room | user + workspace |
| `workspace:subscribe` / `workspace:unsubscribe` | client → server | `{ workspaceId }`, acked |
| `presence:list` | client → server | `workspaceId` |

Rooms: `user:<userId>` and `ws:<workspaceId>`. Membership is checked during the handshake and
re-checked on every subscribe, so removing someone from a workspace stops their stream immediately.

---

## Testing

```bash
npm test
```

```
Test Suites: 5 passed, 5 total
Tests:       62 passed, 62 total
Time:        25.965 s
```

| Suite | Covers |
| --- | --- |
| `tests/auth.test.js` | register/login, cookie + bearer auth, rotation, reuse detection, logout |
| `tests/tasks.test.js` | CRUD, filters, sorting, cursor pagination, report + cache invalidation |
| `tests/authorization.test.js` | RBAC matrix, cross-workspace isolation, unauthenticated access |
| `tests/socket.test.js` | handshake auth, room isolation, broadcast-after-write, presence, Redis fan-out |
| `tests/rateLimit.test.js` | limit enforcement, headers, per-identity buckets, window reset |

The two extra task tests cover the cursor/sort interaction specifically: a cursor minted for
`sort=createdAt` is rejected when replayed against `sort=dueDate` (`CURSOR_SORT_MISMATCH`), and
pagination works on a non-default sort without repeating or dropping a row.

`tests/globalSetup.js` starts one `mongodb-memory-server` and the suite runs with
`REDIS_IN_MEMORY=true`, so no container or local server is required.

### End-to-end smoke test

```bash
npm run smoke
```

Unit tests use `supertest`, which never opens a real socket, so they cannot catch problems that only
appear in a live process. `npm run smoke` starts the actual server as a child process against a
temporary MongoDB and drives 32 assertions over real HTTP with real cookies: health, register,
workspace, task CRUD, cursor pagination (including the cross-sort rejection), report + cache hit,
an authenticated websocket handshake, a `task:created` broadcast, logout with cookie clearing, and
the graceful-shutdown path.

It earned its keep: it caught a shutdown bug where `server.close()` was awaited *before* websockets
were disconnected, so any live Socket.io client made the server hang until the 10 s hard-exit
timeout — on every single deploy.

---

## Benchmark

```bash
npm run benchmark
```

Seeds (or reuses) 100,000 tasks across 20 workspaces, then runs the report aggregation 20 times with
the compound indexes dropped and 20 times with them built, and compares `explain('executionStats')`
before and after.

```
metric              WITHOUT index  WITH index                                improvement
avg latency (ms)    222.94         59.96                                     73.1% faster
min latency (ms)    210.19         56.25                                     73.2% faster
max latency (ms)    252.50         65.24                                     74.2% faster
docsExamined        100,000        3,402                                      96.6% fewer
keysExamined        0              3,404                                      index-only keys
nReturned           3,402          3,402                                      -
winning plan        COLLSCAN       IXSCAN (workspace_1_status_1_assignee_1)  -
index size on disk  -              6.5 MB                                         -
```

Absolute timings depend on the machine and on what else is running; the ratios are the point. Across
runs the index held at 63–75 % lower average latency and a flat 96.6 % fewer documents, while the
absolute numbers moved by more than 2× — which is exactly why `docsExamined` is the number to trust
and the wall-clock one is not.

The scan reads all 100,000 tasks to return 3,402 of them. The index reads 3,404 keys, because the
compound index is ordered by `(workspace, status, assignee)`, which is exactly the `$match` followed
by the `$group` — see the ESR notes in `src/models/Task.js`.

---

## Load test

```bash
npm run loadtest -- --login --connections=50 --duration=10
```

Requires a running server. `--login` registers a throwaway user, keeps the session cookie and
measures authenticated endpoints; without it you get the unauthenticated surface.

---

## Configuration

Everything is environment-driven with development defaults; see `.env.example` for the annotated
list. The ones that matter in production:

| Variable | Notes |
| --- | --- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | **Required.** The app refuses to boot in production while they contain `change-me`. |
| `COOKIE_SECURE` | Defaults to `true` when `NODE_ENV=production`. Turn off only for local HTTP. |
| `COOKIE_SAMESITE` | `strict` by default; use `none` (+ `COOKIE_SECURE=true`) for a cross-site SPA. |
| `CORS_ORIGINS` | Comma-separated allow-list. Never `*` with credentials. |
| `MONGODB_URI`, `REDIS_URL` | Point at your managed instances. |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_AUTH_MAX` | Global and credential-endpoint limits per window. |
| `REPORT_CACHE_TTL` | Report cache TTL in seconds. |

---

## Project layout

```
server.js                     bootstrap, HTTP server, Socket.io, graceful shutdown
src/
  app.js                      Express middleware stack and route mounting
  config/                     env, logger, Mongo, Redis (+ in-process Redis substitute)
  models/                     User, Workspace, Task, ActivityLog (index rationale inline)
  routes/                     auth, workspace, nested task routes, health
  controllers/                request → service → response
  services/                   auth, workspace, task, report, cache, activity
  middleware/                 authenticate, authorize, validate, rateLimit, errorHandler
  sockets/                    handshake auth, rooms, presence, Redis adapter
  utils/                      jwt, pagination (keyset cursor), AppError, asyncHandler
scripts/
  seed.js                     bulk dataset generator
  benchmark.js                indexed vs non-indexed report benchmark
  loadtest.js                 autocannon load test
  smoke.js                    end-to-end check against a live server
  lib/mongo.js                real-or-ephemeral MongoDB
  lib/seedData.js             dataset generator shared by seed + benchmark
  lib/selfSignalServer.js     shutdown harness (Windows has no process signals)
tests/                        5 suites, 60 tests
docs/EXPLANATION.md           design decisions, trade-offs, interview Q&A
postman/                      Postman collection
```

---

## Security notes

- Passwords hashed with bcrypt (cost configurable, default 10); login always runs a bcrypt compare so
  response time does not reveal whether an account exists.
- Refresh tokens are single-use. Presenting a rotated one is treated as theft and revokes the whole
  token family.
- Cookies are `HttpOnly`; the refresh cookie is additionally path-scoped to `/api/v1/auth`.
- `express-mongo-sanitize` strips `$`-prefixed and dotted keys from body, query and params, which
  blocks `?email[$ne]=` operator injection.
- Helmet, a 1 MB body cap, strict Zod schemas and a CORS allow-list.
- Rate limiting is Redis-backed so the limit is shared across instances, and it **fails open**: a
  Redis outage must not take the API down.
- `trust proxy` is enabled in production so the client IP (and therefore the limit bucket) is real.

## License

MIT
