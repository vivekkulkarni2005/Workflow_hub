'use strict';

const express = require('express');
const request = require('supertest');
const { rateLimit } = require('../src/middleware/rateLimit');
const { resetRedis } = require('./helpers');

/**
 * The limiter is exercised directly (no module reload tricks): it is a plain
 * middleware, so we mount it on a throwaway app with a tiny limit and drive it
 * with supertest. The counters still live in Redis, exactly as in production.
 */
describe('rate limiting', () => {
  beforeEach(resetRedis);

  const buildApp = (options) => {
    const app = express();
    app.use(rateLimit(options));
    app.get('/ping', (req, res) => res.json({ ok: true }));
    // Same JSON error contract the real app installs in src/middleware/errorHandler.js
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) =>
      res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } })
    );
    return app;
  };

  it('blocks after `max` requests and exposes the standard headers', async () => {
    const app = buildApp({ windowMs: 60_000, max: 3, bucket: 'test-basic' });

    for (let i = 0; i < 3; i += 1) {
      const ok = await request(app).get('/ping');
      expect(ok.status).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('3');
      expect(ok.headers['ratelimit-remaining']).toBe(String(2 - i));
    }

    const blocked = await request(app).get('/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('keeps separate counters per identity (per client id)', async () => {
    const app = buildApp({ windowMs: 60_000, max: 1, bucket: 'test-bucket' });
    const pass = { id: 'user-a' };
    const other = { id: 'user-b' };

    const one = (client) => (req, _res, next) => {
      req.userId = client.id;
      next();
    };

    const authed = express();
    authed.use(one(pass));
    authed.use(rateLimit({ windowMs: 60_000, max: 1, bucket: 'test-bucket' }));
    authed.get('/ping', (req, res) => res.json({ ok: true }));

    await request(authed).get('/ping').expect(200);
    await request(authed).get('/ping').expect(429);

    // A different user has their own bucket and is unaffected.
    const otherApp = express();
    otherApp.use(one(other));
    otherApp.use(rateLimit({ windowMs: 60_000, max: 1, bucket: 'test-bucket' }));
    otherApp.get('/ping', (req, res) => res.json({ ok: true }));
    await request(otherApp).get('/ping').expect(200);
  });

  it('resets the counter once the window expires', async () => {
    const app = buildApp({ windowMs: 120, max: 1, bucket: 'test-expiry' });
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(429);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await request(app).get('/ping').expect(200);
  });
});
