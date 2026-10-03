'use strict';

const pino = require('pino');
const env = require('./env');

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
];

function prettyTransport() {
  if (env.isProd) return undefined;
  try {
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
    };
  } catch {
    return undefined; // production-style JSON logging
  }
}

const logger = pino({
  level: env.isTest ? 'silent' : env.logLevel,
  base: { service: 'workflow-hub' },
  redact: { paths: redactPaths, censor: '[redacted]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty output is a dev-only convenience: `pino-pretty` is a devDependency,
  // so a production install (npm ci --omit=dev) must fall back to plain JSON.
  transport: prettyTransport(),
});

module.exports = logger;
module.exports.logger = logger;
