'use strict';

const { createClient } = require('../config/redis');
const logger = require('../config/logger');
const env = require('../config/env');
const { verifyAccessToken, hashToken } = require('../utils/jwt');
const Workspace = require('../models/Workspace');
const AppError = require('../utils/AppError');

/** Minimal cookie header parser (avoids pulling cookie-parser into the hot path). */
function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Socket.io handshake authentication.
 *
 * The browser sends the HttpOnly auth cookie automatically with the handshake
 * request (same-origin), so the server can authenticate the *upgrade* — no
 * token ever travels through client-side JavaScript, and a socket can never be
 * upgraded by an unauthenticated peer.
 *
 * Rejecting here (throw) closes the connection during the handshake, before
 * any room is joined or any event is delivered.
 */
async function socketAuth(socket, next) {
  try {
    const cookies = parseCookies(socket.handshake.headers?.cookie);
    const token = cookies[env.cookies.accessName] || socket.handshake.auth?.token;

    if (!token) return next(new Error('UNAUTHORIZED: no token'));

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      return next(new Error(`UNAUTHORIZED: ${err.message}`));
    }

    const memberships = await Workspace.find({ 'members.user': payload.sub })
      .select('_id name slug')
      .lean();

    socket.data.userId = String(payload.sub);
    socket.data.tokenHash = hashToken(token).slice(0, 12);
    socket.data.rooms = new Set();
    socket.data.workspaces = new Map(memberships.map((w) => [String(w._id), w]));
    socket.data.connectedAt = Date.now();

    return next();
  } catch (err) {
    logger.error({ err: err.message }, 'socket auth failure');
    return next(new Error('UNAUTHORIZED: handshake failed'));
  }
}

const presence = require('./presence');

/** Wires an authenticated socket to the workspace rooms it is allowed to see. */
function registerSocket(io, socket) {
  const userId = socket.data.userId;
  const userRoom = `user:${userId}`;
  socket.join(userRoom);
  socket.data.rooms.add(userRoom);

  // Auto-join every workspace the user belongs to, so a fresh tab immediately
  // receives task events without an explicit subscribe round-trip.
  for (const [wsId] of socket.data.workspaces) {
    socket.join(`ws:${wsId}`);
    socket.data.rooms.add(`ws:${wsId}`);
  }

  presence.userConnected(io, socket, userId);

  socket.on('workspace:subscribe', async (payload, ack) => {
    try {
      const workspaceId = String(payload?.workspaceId ?? payload ?? '');
      if (!workspaceId) throw AppError.badRequest('workspaceId required', 'MISSING_WORKSPACE_ID');

      // Membership is re-checked here: a token issued before a removal must not
      // keep streaming another workspace's data.
      const isMember = socket.data.workspaces.has(workspaceId)
        || (await Workspace.exists({ _id: workspaceId, 'members.user': userId }));
      if (!isMember) {
        throw AppError.forbidden('Not a member of this workspace', 'NOT_A_MEMBER');
      }

      socket.join(`ws:${workspaceId}`);
      socket.data.rooms.add(`ws:${workspaceId}`);
      presence.userJoinedWorkspace(io, socket, workspaceId);
      if (typeof ack === 'function') ack({ ok: true, room: `ws:${workspaceId}` });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message, code: err.code });
      else socket.emit('error:message', { message: err.message, code: err.code });
    }
  });

  socket.on('workspace:unsubscribe', (payload, ack) => {
    const workspaceId = String(payload?.workspaceId ?? payload ?? '');
    const room = `ws:${workspaceId}`;
    if (socket.data.rooms.has(room)) {
      socket.leave(room);
      socket.data.rooms.delete(room);
      presence.userLeftWorkspace(io, socket, workspaceId);
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('presence:list', (workspaceId) => {
    const online = presence.onlineIn(io, String(workspaceId));
    socket.emit('presence:state', { workspaceId: String(workspaceId), online });
  });

  socket.on('disconnect', (reason) => {
    presence.userDisconnected(io, socket, reason);
    logger.debug({ userId, rooms: [...socket.data.rooms] }, 'socket disconnected');
  });
}

module.exports = { socketAuth, registerSocket, parseCookies, createClient };
