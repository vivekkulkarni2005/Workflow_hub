'use strict';

/**
 * LOAD TEST — hammers the REST API with autocannon and prints p50/p90/p99.
 *
 *   npm run loadtest
 *   npm run loadtest -- --url=http://localhost:4000 --connections=100 --duration=20
 *   npm run loadtest -- --login          # register + log in first, then use the cookie
 *
 * By default it drives the *unauthenticated* surface, which needs no setup.
 * With `--login` it creates a throwaway user, keeps the returned session cookie
 * and measures authenticated endpoints instead.
 */

const autocannon = require('autocannon');

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE = String(argv.url || 'http://localhost:4000').replace(/\/$/, '');
const CONNECTIONS = Number(argv.connections || 50);
const DURATION = Number(argv.duration || 10);

let cookie = '';

/** POSTs JSON and returns the response body. */
async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(',').map((c) => c.split(';')[0]).join('; ');
  return res.json().catch(() => ({}));
}

async function setupAuthenticated() {
  const email = `loadtest+${Date.now()}@example.test`;
  await api('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Load Test', email, password: 'LoadTest123!', workspaceName: 'Load Test WS' }),
  });
  await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'LoadTest123!' }),
  });
  if (!cookie) throw new Error('login did not return a session cookie');

  const workspaces = await api('/api/v1/workspaces');
  const workspaceId = workspaces?.data?.[0]?._id ?? workspaces?.data?.[0]?.id;
  if (!workspaceId) throw new Error('no workspace found for the new user');
  return workspaceId;
}

const fmt = (n) => Number(n).toFixed(2);

function report(result, title) {
  console.log(`\n--- ${title} ---`);
  console.log(`  requests      : ${result.requests.total} (${result.requests.sent}/s)`);
  console.log(`  throughput    : ${fmt(result.throughput.average)} req/s`);
  console.log(`  latency p50   : ${fmt(result.latency.p50)} ms`);
  console.log(`  latency p90   : ${fmt(result.latency.p90)} ms`);
  console.log(`  latency p99   : ${fmt(result.latency.p99)} ms`);
  console.log(`  latency max   : ${fmt(result.latency.max)} ms`);
  console.log(`  errors        : ${result.errors} (non-2xx: ${result.non2xx})`);
  console.log(`  timeouts      : ${result.timeouts}`);
  console.log(
    `  rate limited  : ${result['rateLimit'] ? 'yes' : 'no'}` +
      (result.non2xx ? '  <-- check whether you are hitting RATE_LIMIT_MAX' : '')
  );
}

function run(title, { url, method, body, headers }) {
  return new Promise((resolve) => {
    const instance = autocannon(
      { url: `${BASE}${url}`, connections: CONNECTIONS, duration: DURATION, method, body, headers },
      (err, result) => {
        if (err) {
          console.error(`\n${title} failed:`, err.message);
          process.exit(1);
        }
        report(result, title);
        resolve();
      }
    );
    autocannon.track(instance, { renderProgressBar: true, renderLatencyChart: false });
  });
}

async function main() {
  console.log(`Load test -> ${BASE}  (${CONNECTIONS} connections, ${DURATION}s per scenario)`);

  // Fail fast with a clear message if the server is not reachable at all.
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error(`\nCannot reach ${BASE} (${err.message}).`);
    console.error('Start the stack first:  docker compose up --build');
    process.exit(1);
  }

  if (argv.login) {
    const workspaceId = await setupAuthenticated();
    console.log(`Authenticated. Workspace: ${workspaceId}`);
    await run('GET  /api/v1/workspaces (authed, cached)', { url: '/api/v1/workspaces' });
    await run('GET  /api/v1/workspaces/:id/tasks?limit=20 (authed)', {
      url: `/api/v1/workspaces/${workspaceId}/tasks?limit=20`,
    });
    await run('GET  /api/v1/workspaces/:id/report (authed, cached)', {
      url: `/api/v1/workspaces/${workspaceId}/report`,
    });
  } else {
    console.log('Unauthenticated run. Add --login to measure authenticated endpoints.');
    await run('GET  /health (liveness)', { url: '/health' });
    await run('GET  /health/ready (readiness)', { url: '/health/ready' });
    await run('POST /api/v1/auth/login (bad password -> 401)', {
      url: '/api/v1/auth/login',
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password' }),
    });
  }

  console.log(
    '\nNote: /auth has its own much stricter limit (RATE_LIMIT_AUTH_MAX=10/min by default),\n' +
      'so a 429-heavy login result above is the limiter working, not a slow server.\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
