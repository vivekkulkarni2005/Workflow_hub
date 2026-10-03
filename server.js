'use strict';

const http = require('http');
const env = require('./src/config/env');
const logger = require('./src/config/logger');
const { connectDb, disconnectDb, dbState } = require('./src/config/db');
const { connectRedis, quitRedis, getMode } = require('./src/config/redis');
const { createApp } = require('./src/app');
const { initSockets, closeSockets } = require('./src/sockets');

async function bootstrap() {
  await connectDb();
  await connectRedis();

  const app = createApp();
  const server = http.createServer(app);
  initSockets(server);

  // Keep-alive slightly above the typical 60s LB idle timeout to avoid races
  // where the proxy reuses a socket the server is closing.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await new Promise((resolve) => server.listen(env.port, env.host, resolve));
  logger.info(
    {
      port: env.port,
      env: env.nodeEnv,
      redis: getMode(),
      pid: process.pid,
    },
    `workflow-hub listening on http://${env.host}:${env.port}`
  );

  installShutdownHandlers(server);
  return server;
}

/**
 * GRACEFUL SHUTDOWN
 *
 * On SIGTERM (k8s / docker stop) we must stop accepting NEW work, let in-flight
 * requests finish, then close resources in dependency order. We race a hard
 * timeout so a stuck connection can never block the deploy forever.
 */
function installShutdownHandlers(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown started');

    const forceExit = setTimeout(() => {
      logger.fatal('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, env.shutdownTimeoutMs);
    forceExit.unref();

    try {
      // 1. Stop accepting NEW connections. The callback is deliberately not
      //    awaited yet: `server.close()` only resolves once every existing
      //    connection is gone, and upgraded websocket connections never go
      //    away on their own. Awaiting it here would hang until the hard
      //    timeout on any deploy with a live Socket.io client.
      const httpDrained = new Promise((resolve) => server.close(resolve));

      // 2. Disconnect websockets so those connections actually close, and give
      //    in-flight plain HTTP requests a moment to finish.
      await closeSockets();
      // 3. Drop idle keep-alive sockets: a client that is not sending a request
      //    right now would otherwise hold the server open for the full
      //    keep-alive window even though it has no work in flight.
      server.closeIdleConnections?.();
      await httpDrained;
      server.closeAllConnections?.();
      logger.info('http server closed');

      // 4. Release caches, then the database pool.
      await quitRedis();
      await disconnectDb();

      logger.info({ mongo: dbState() }, 'shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash must leave a clear log line; the orchestrator restarts us.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    shutdown('uncaughtException').finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason: String(reason) }, 'unhandled promise rejection');
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'failed to start');
    process.exit(1);
  });
}

module.exports = { bootstrap, installShutdownHandlers };
