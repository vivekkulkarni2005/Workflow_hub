'use strict';

const { Server } = require('socket.io');
const { createClient } = require('../config/redis');
const env = require('../config/env');
const logger = require('../config/logger');
const { socketAuth, registerSocket } = require('./handlers');

let io = null;

function getIO() {
  return io;
}

/**
 * Attaches Socket.io to the HTTP server and, when Redis is available, plugs in
 * the Redis adapter.
 *
 * The adapter is what makes the app horizontally scalable: `io.to(room).emit()`
 * normally only reaches sockets attached to *this* process. With the adapter
 * every publish is fanned out over Redis pub/sub to all other instances, so a
 * client connected to instance B still receives an event emitted on instance A.
 */
function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    path: '/socket.io',
    pingTimeout: 20_000,
    pingInterval: 25_000,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  // Authenticate during the handshake, before the socket is usable.
  io.use(socketAuth);

  io.on('connection', (socket) => {
    logger.debug(
      { socketId: socket.id, userId: socket.data.userId, rooms: socket.data.workspaces.size },
      'socket connected'
    );
    socket.emit('connected', {
      socketId: socket.id,
      userId: socket.data.userId,
      workspaces: [...socket.data.workspaces.values()],
      connectedAt: socket.data.connectedAt,
    });
    registerSocket(io, socket);
  });

  attachRedisAdapter();

  return io;
}

function attachRedisAdapter() {
  try {
    // eslint-disable-next-line global-require
    const { createAdapter } = require('@socket.io/redis-adapter');
    const pubClient = createClient();
    const subClient = createClient();
    io.adapter(createAdapter(pubClient, subClient, { key: 'workflow-hub:socket' }));
    logger.info('socket.io redis adapter attached (multi-instance ready)');
  } catch (err) {
    logger.warn({ err: err.message }, 'redis adapter unavailable, running single-instance');
  }
}

async function closeSockets() {
  if (!io) return;
  await new Promise((resolve) => io.close(resolve));
  io = null;
}

module.exports = { initSockets, getIO, closeSockets };
