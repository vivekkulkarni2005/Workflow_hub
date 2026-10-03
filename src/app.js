'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const pinoHttp = require('pino-http');
const crypto = require('crypto');

const env = require('./config/env');
const logger = require('./config/logger');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { apiRateLimit } = require('./middleware/rateLimit');

/**
 * Builds the Express application. Kept separate from server.js so tests can
 * mount it with supertest without opening a TCP port or starting Socket.io.
 */
function createApp() {
  const app = express();

  // 1) Behind a load balancer: trust the proxy so req.ip is the real client IP
  //    (rate limiting depends on it). Must be the FIRST middleware.
  app.set('trust proxy', env.isProd ? 1 : false);
  app.disable('x-powered-by');

  // 2) Structured request logging with request-id correlation.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    })
  );

  // 3) Security headers: HSTS, no-sniff, CSP, frame-deny, referrer policy...
  app.use(helmet());
  app.use(
    helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }) // so the SPA can call us
  );

  // 4) CORS allow-list. `credentials: true` requires an explicit origin (never
  //    "*"), otherwise browsers reject the response — and cookies need it.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl / server-to-server
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 86_400,
    })
  );

  // 5) Body parsing with a hard size cap (DoS guard).
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // 6) Neutralise NoSQL operator injection ("?email[$ne]=null" style attacks).
  //    express-mongo-sanitize mutates req.body/query/params in place.
  app.use(mongoSanitize({ allowDots: false, removeWrites: true }));

  // 7) Redis-backed rate limiting for the whole API surface.
  app.use('/api', apiRateLimit);

  // 8) Routes.
  app.use(routes);

  // 9) 404 + central error handler (must be last, error handler needs 4 args).
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
