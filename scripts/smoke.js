'use strict';

/**
 * END-TO-END SMOKE TEST
 *
 * Boots a real HTTP server as a SEPARATE process (so `server.js` and the
 * graceful-shutdown path are genuinely exercised), points it at a temporary
 * in-memory MongoDB, then drives the full flow over HTTP with real cookies:
 *
 *   register -> create workspace -> create task -> list -> paginate
 *   -> report -> open a websocket -> observe the broadcast -> logout
 *
 * Run with:  node scripts/smoke.js
 */

const { spawn } = require('child_process');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { io } = require('socket.io-client');

const PORT = 4111;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let cookieJar = '';

function ok(label, condition, extra = '') {
  if (condition) {
    console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra ? `  (${extra})` : ''}`);
  }
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieJar ? { Cookie: cookieJar } : {}),
      ...options.headers,
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    cookieJar = setCookie
      .split(/,(?=[^;]+?=)/)
      .map((c) => c.split(';')[0].trim())
      .join('; ');
  }
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

/** Pulls the access token back out of the cookie jar for the bearer check. */
function readAccessCookie() {
  const match = /wf_access=([^;]+)/.exec(cookieJar);
  return match ? decodeURIComponent(match[1]) : null;
}

function waitForLog(child, needle, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${needle}"`)), timeoutMs);
    const onData = (chunk) => {
      buffered += chunk.toString();
      if (buffered.includes(needle)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'workflow-hub-smoke' } });
  const uri = mongod.getUri('workflow-hub-smoke');
  console.log(`\ntemporary mongo: ${uri}\n`);

  // On win32 the server is launched through a wrapper that can raise SIGTERM on
  // itself; everywhere else the real entry point is used.
  const entry =
    process.platform === 'win32'
      ? path.join(__dirname, 'lib', 'selfSignalServer.js')
      : path.join(__dirname, '..', 'server.js');

  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MONGODB_URI: uri,
      REDIS_IN_MEMORY: 'true',
      JWT_ACCESS_SECRET: 'smoke-access-secret',
      JWT_REFRESH_SECRET: 'smoke-refresh-secret',
      LOG_LEVEL: 'info',
      BCRYPT_ROUNDS: '4',
      RATE_LIMIT_MAX: '10000',
      RATE_LIMIT_AUTH_MAX: '10000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (c) => {
    serverLog += c.toString();
  });
  child.stderr.on('data', (c) => {
    serverLog += c.toString();
  });

  let socket = null;
  try {
    await waitForLog(child, 'listening on');
    console.log('  PASS  server booted and logged "listening on"');

    // --- health ---------------------------------------------------------
    const live = await api('/health');
    ok('GET /health -> 200', live.status === 200, `status=${live.status}`);

    const ready = await api('/health/ready');
    ok(
      'GET /health/ready -> 200 with mongo+redis up',
      ready.status === 200 && ready.body.checks.mongo === 'up' && ready.body.checks.redis === 'up',
      JSON.stringify(ready.body.checks)
    );

    // --- auth -----------------------------------------------------------
    const email = `smoke+${Date.now()}@example.test`;
    const reg = await api('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Smoke User', email, password: 'SmokePass123!' }),
    });
    ok('POST /api/v1/auth/register -> 201', reg.status === 201, `status=${reg.status}`);
    ok('session cookie was stored', cookieJar.includes('wf_access'));
    const userId = reg.body.user?.id;

    // --- workspace ------------------------------------------------------
    const ws = await api('/api/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Smoke WS', description: 'end-to-end' }),
    });
    ok('POST /api/v1/workspaces -> 201', ws.status === 201, `status=${ws.status}`);
    const workspaceId = ws.body.workspace?._id;
    ok('creator is owner', ws.body.workspace?.members?.[0]?.role === 'owner');

    const wsList = await api('/api/v1/workspaces?limit=10');
    ok('GET /api/v1/workspaces -> 200', wsList.status === 200, `items=${wsList.body.items?.length}`);

    // --- tasks ----------------------------------------------------------
    const created = [];
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const t = await api(`/api/v1/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: `Smoke task ${i}`,
          priority: i % 2 === 0 ? 'urgent' : 'low',
          // Assigned, because the report groups by assignee and only counts
          // tasks that have one.
          assignee: userId,
          dueDate: i % 3 === 0 ? '2020-01-01T00:00:00.000Z' : '2030-01-01T00:00:00.000Z',
        }),
      });
      created.push(t.body.task);
    }
    ok('POST task x12 -> all 201', created.every((t) => t && t._id), `created=${created.length}`);

    const page1 = await api(`/api/v1/workspaces/${workspaceId}/tasks?limit=5`);
    ok('GET tasks?limit=5 -> 5 items + cursor', page1.body.items?.length === 5 && !!page1.body.nextCursor);
    const page2 = await api(
      `/api/v1/workspaces/${workspaceId}/tasks?limit=5&cursor=${encodeURIComponent(page1.body.nextCursor)}`
    );
    const ids1 = new Set(page1.body.items.map((t) => t._id));
    const overlap = page2.body.items.filter((t) => ids1.has(t._id));
    ok('page 2 does not repeat page 1', overlap.length === 0, `overlap=${overlap.length}`);

    const mismatch = await api(
      `/api/v1/workspaces/${workspaceId}/tasks?limit=5&sort=dueDate&cursor=${encodeURIComponent(page1.body.nextCursor)}`
    );
    ok(
      'cursor from another sort is rejected',
      mismatch.status === 400 && mismatch.body.error?.code === 'CURSOR_SORT_MISMATCH',
      `code=${mismatch.body.error?.code}`
    );

    const badCursor = await api(`/api/v1/workspaces/${workspaceId}/tasks?cursor=zzzz`);
    ok(
      'malformed cursor -> 400 INVALID_CURSOR',
      badCursor.status === 400 && badCursor.body.error?.code === 'INVALID_CURSOR'
    );

    const badBody = await api(`/api/v1/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '' }),
    });
    ok('invalid task body -> 422', badBody.status === 422, `status=${badBody.status}`);

    // --- authorization --------------------------------------------------
    const outsider = await fetch(`${BASE}/api/v1/workspaces/${workspaceId}`, {
      headers: { Cookie: cookieJar },
    });
    ok('owner can read the workspace', outsider.status === 200, `status=${outsider.status}`);

    const anonymous = await fetch(`${BASE}/api/v1/workspaces/${workspaceId}`);
    ok('anonymous -> 401', anonymous.status === 401, `status=${anonymous.status}`);

    // --- report ---------------------------------------------------------
    const report1 = await api(`/api/v1/workspaces/${workspaceId}/reports`);
    ok('GET reports -> 200', report1.status === 200, `status=${report1.status}`);
    ok('report was computed (not cached)', report1.body.cached === false);
    ok('report totals 12 open tasks', report1.body.totals?.open === 12, `open=${report1.body.totals?.open}`);
    const report2 = await api(`/api/v1/workspaces/${workspaceId}/reports`);
    ok('second report read is served from cache', report2.body.cached === true);

    // --- websocket ------------------------------------------------------
    socket = io(BASE, { transports: ['websocket'], extraHeaders: { Cookie: cookieJar } });
    const events = [];
    for (const name of ['task:created', 'task:updated', 'task:deleted', 'presence:joined']) {
      socket.on(name, (payload) => events.push({ name, payload }));
    }
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket did not connect')), 10000);
    });
    ok('websocket handshake authenticated via cookie', socket.connected);

    // The REST create must show up on the socket, proving the emit happens
    // AFTER the write rather than instead of it.
    const viaSocket = await api(`/api/v1/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Realtime task' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const broadcast = events.find((e) => e.name === 'task:created' && e.payload?.task?._id === viaSocket.body.task._id);
    ok('task:created broadcast for the new task', !!broadcast, broadcast ? 'received' : 'not received');

    const fetched = await api(
      `/api/v1/workspaces/${workspaceId}/tasks/${viaSocket.body.task._id}`
    );
    ok('broadcast task is already readable over HTTP', fetched.status === 200);

    // --- logout ---------------------------------------------------------
    // Keep the raw access token: logout clears the *cookies*, but the token
    // itself stays valid until it expires (that is what "stateless access JWT"
    // means). The refresh family, by contrast, must be dead immediately.
    const accessToken = (await api('/api/v1/auth/me')).status === 200 ? readAccessCookie() : null;
    ok('access token was readable before logout', !!accessToken);

    const out = await api('/api/v1/auth/logout', { method: 'POST' });
    ok('POST /auth/logout -> 204', out.status === 204, `status=${out.status}`);
    ok('logout cleared the auth cookies', !/wf_access=[^;]+/.test(cookieJar), cookieJar || '(jar empty)');

    const afterLogout = await api('/api/v1/auth/me');
    ok('cookies gone -> /me is 401', afterLogout.status === 401, `status=${afterLogout.status}`);

    const viaBearer = await fetch(`${BASE}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    ok(
      'access JWT is still valid until it expires (15m TTL)',
      viaBearer.status === 200,
      `status=${viaBearer.status}`
    );

    const refreshed = await api('/api/v1/auth/refresh', { method: 'POST', body: '{}' });
    ok('refresh after logout -> 401 (family revoked)', refreshed.status === 401, `status=${refreshed.status}`);

    // --- graceful shutdown ---------------------------------------------
    // Windows has no process signals: `child.kill('SIGTERM')` there terminates
    // the process outright and the Node handler never runs. So on win32 the
    // server raises the signal on ITSELF, which exercises the identical
    // shutdown code path (`installShutdownHandlers` -> drain -> close -> exit).
    if (process.platform === 'win32') {
      const exitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve('TIMEOUT');
        }, 25000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        // Ask the server to raise the signal on itself via stdin.
        child.stdin.write('SIGTERM\n');
      });
      ok('graceful shutdown exits 0 (self-signal on win32)', exitCode === 0, `exit=${exitCode}`);
    } else {
      const exitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve('TIMEOUT');
        }, 25000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.kill('SIGTERM');
      });
      ok('SIGTERM triggers a clean exit', exitCode === 0, `exit=${exitCode}`);
    }

    ok(
      'shutdown drained the server before closing deps',
      serverLog.includes('graceful shutdown started') && serverLog.includes('shutdown complete'),
      serverLog.includes('shutdown complete') ? 'logged' : 'missing log lines'
    );
  } catch (err) {
    failures += 1;
    console.error('\nSmoke test aborted:', err.message);
    if (serverLog.trim()) console.error(`\n--- server log ---\n${serverLog.slice(-2000)}`);
  } finally {
    if (socket) socket.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await mongod.stop().catch(() => {});
  }

  if (failures > 0 && serverLog.trim()) {
    console.error(`\n--- server log (tail) ---\n${serverLog.slice(-3000)}`);
  }

  console.log(
    failures === 0
      ? '\nSMOKE TEST PASSED - the server really works end to end.\n'
      : `\nSMOKE TEST FAILED: ${failures} check(s) failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
