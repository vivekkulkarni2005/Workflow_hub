'use strict';

const { getClient } = require('../config/redis');
const logger = require('../config/logger');

/**
 * Presence is tracked in a Redis SET per workspace so it stays correct when the
 * fleet is scaled to more than one instance (a plain in-process Map would only
 * know about the local instance). SADD/SREM are idempotent, and a heartbeat
 * key with a TTL reaps users whose process died without a clean disconnect.
 */
const KEY = (workspaceId) => `presence:ws:${workspaceId}`;
const HEARTBEAT_TTL_SECONDS = 70;

function workspacesOf(socket) {
  return [...socket.data.rooms].filter((r) => r.startsWith('ws:')).map((r) => r.slice(3));
}

function memberCount(io, room) {
  return io?.sockets.adapter.rooms.get(room)?.size ?? 0;
}

async function userConnected(io, socket, userId) {
  const rooms = workspacesOf(socket);
  const client = getClient();
  if (client) {
    for (const wsId of rooms) {
      await client.sadd(KEY(wsId), userId);
      await client.expire(KEY(wsId), HEARTBEAT_TTL_SECONDS);
    }
  }
  for (const wsId of rooms) {
    io.to(`ws:${wsId}`).emit('presence:online', {
      workspaceId: wsId,
      userId,
      online: memberCount(io, `ws:${wsId}`),
    });
  }
  socket.broadcast.emit('presence:online', { userId, socketId: socket.id });
}

async function userJoinedWorkspace(io, socket, workspaceId) {
  const userId = socket.data.userId;
  const client = getClient();
  if (client) {
    await client.sadd(KEY(workspaceId), userId);
    await client.expire(KEY(workspaceId), HEARTBEAT_TTL_SECONDS);
  }
  io.to(`ws:${workspaceId}`).emit('presence:online', {
    workspaceId,
    userId,
    online: memberCount(io, `ws:${workspaceId}`),
  });
  socket.to(`ws:${workspaceId}`).emit('presence:joined', { workspaceId, userId });
}

async function userLeftWorkspace(io, socket, workspaceId) {
  const userId = socket.data.userId;
  const client = getClient();
  if (client) await client.srem(KEY(workspaceId), userId);
  io.to(`ws:${workspaceId}`).emit('presence:offline', {
    workspaceId,
    userId,
    online: memberCount(io, `ws:${workspaceId}`),
  });
}

async function userDisconnected(io, socket, reason) {
  const userId = socket.data.userId;
  const rooms = workspacesOf(socket);
  const client = getClient();
  for (const wsId of rooms) {
    if (client) await client.srem(KEY(wsId), userId);
    io.to(`ws:${wsId}`).emit('presence:offline', {
      workspaceId: wsId,
      userId,
      online: memberCount(io, `ws:${wsId}`),
      reason,
    });
  }
  logger.debug({ userId, reason }, 'presence updated');
}

async function onlineIn(io, workspaceId) {
  const client = getClient();
  if (!client) return [];
  const users = await client.smembers(KEY(workspaceId));
  return users;
}

module.exports = {
  userConnected,
  userJoinedWorkspace,
  userLeftWorkspace,
  userDisconnected,
  onlineIn,
  KEY,
  HEARTBEAT_TTL_SECONDS,
};
