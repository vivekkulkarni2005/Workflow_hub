'use strict';

const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { createApp } = require('../src/app');
const { initSockets, closeSockets, getIO } = require('../src/sockets');
const { agent, registerUser, createWorkspace, addMember, resetRedis } = require('./helpers');

/**
 * Waits for a named event (optionally matching a predicate) and fails fast
 * instead of hanging until Jest's global timeout.
 */
function waitFor(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for "${event}"`)),
      timeout
    );
    const handler = (payload) => {
      if (!predicate(payload)) return; // ignore events meant for someone else
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Connects with the auth cookie and resolves only once the socket is usable. */
function connect(port, cookies) {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    path: '/socket.io',
    transports: ['websocket'],
    extraHeaders: { Cookie: cookies },
    reconnection: false,
  });
  // Registered before the handshake completes so the server's first emit (the
  // `connected` greeting) can never be missed.
  const hello = new Promise((resolve, reject) => {
    socket.once('connected', resolve);
    socket.once('connect_error', reject);
  });
  return { socket, hello };
}

function expectRejected(port, cookies) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { Cookie: cookies },
      reconnection: false,
    });
    socket.once('connect', () => {
      socket.close();
      reject(new Error('expected the handshake to be rejected'));
    });
    socket.once('connect_error', (err) => {
      socket.close();
      resolve(err.message);
    });
  });
}

const authCookie = (user) => `wf_access=${user.accessToken}`;

/** Server-side view of a room's members (the client socket has no `rooms`). */
const roomMembers = (room) => getIO().sockets.adapter.rooms.get(room) ?? new Set();

describe('socket.io', () => {
  let server;
  let port;
  let owner;
  let member;
  let stranger;
  let workspace;
  const open = [];

  beforeAll(async () => {
    server = http.createServer(createApp());
    initSockets(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    open.splice(0).forEach((s) => s.close());
    await closeSockets();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    await resetRedis();
    owner = await registerUser({ name: 'Owner' });
    member = await registerUser({ name: 'Member' });
    stranger = await registerUser({ name: 'Stranger' });
    workspace = (await createWorkspace(owner.bearer, 'Socket Co')).workspace;
    await addMember(workspace._id, owner.bearer, member.user.id, 'member');
  });

  it('rejects a handshake with no token', async () => {
    expect(await expectRejected(port, '')).toMatch(/UNAUTHORIZED/);
  });

  it('rejects a handshake with a forged token', async () => {
    expect(await expectRejected(port, 'wf_access=forged.token.value')).toMatch(/UNAUTHORIZED/);
  });

  it('accepts the JWT cookie and auto-joins the member workspaces', async () => {
    const { socket, hello } = connect(port, authCookie(owner));
    open.push(socket);

    const greeting = await hello;
    expect(greeting.userId).toBe(owner.user.id);
    expect(greeting.workspaces.map((w) => w._id)).toContain(workspace._id);
    expect(roomMembers(`ws:${workspace._id}`).has(socket.id)).toBe(true);
    socket.close();
  });

  it('broadcasts task:created only to members of that workspace', async () => {
    const memberConn = connect(port, authCookie(member));
    const strangerConn = connect(port, authCookie(stranger));
    await Promise.all([memberConn.hello, strangerConn.hello]);
    open.push(memberConn.socket, strangerConn.socket);

    const heard = waitFor(memberConn.socket, 'task:created');
    const leaked = waitFor(strangerConn.socket, 'task:created', () => true, 1000).then(
      () => 'leaked',
      () => 'silent'
    );

    await agent()
      .post(`/api/v1/workspaces/${workspace._id}/tasks`)
      .set('Authorization', owner.bearer)
      .send({ title: 'Broadcast me' })
      .expect(201);

    const event = await heard;
    expect(event.task.title).toBe('Broadcast me');
    expect(event.workspaceId).toBe(workspace._id);
    expect(await leaked).toBe('silent');

    memberConn.socket.close();
    strangerConn.socket.close();
  });

  it('emits task:updated and task:deleted after the DB write', async () => {
    const { socket, hello } = connect(port, authCookie(owner));
    await hello;
    open.push(socket);

    // The listener must be armed BEFORE the request, otherwise the event is
    // emitted (and lost) before anyone is listening.
    const willBeCreated = waitFor(socket, 'task:created');
    const created = await agent()
      .post(`/api/v1/workspaces/${workspace._id}/tasks`)
      .set('Authorization', owner.bearer)
      .send({ title: 'Lifecycle' })
      .expect(201);
    expect((await willBeCreated).task._id).toBe(created.body.task._id);

    const updated = waitFor(socket, 'task:updated', (e) => e.task._id === created.body.task._id);
    await agent()
      .patch(`/api/v1/workspaces/${workspace._id}/tasks/${created.body.task._id}`)
      .set('Authorization', owner.bearer)
      .send({ status: 'done' })
      .expect(200);
    const updateEvent = await updated;
    expect(updateEvent.task.status).toBe('done');
    expect(updateEvent.updatedBy).toBe(owner.user.id);

    const deleted = waitFor(socket, 'task:deleted', (e) => e.taskId === created.body.task._id);
    await agent()
      .delete(`/api/v1/workspaces/${workspace._id}/tasks/${created.body.task._id}`)
      .set('Authorization', owner.bearer)
      .expect(204);
    expect((await deleted).deletedBy).toBe(owner.user.id);

    socket.close();
  });

  it('refuses workspace:subscribe for a non-member but accepts it for a member', async () => {
    const strangerConn = connect(port, authCookie(stranger));
    await strangerConn.hello;
    open.push(strangerConn.socket);

    const denial = await new Promise((resolve) =>
      strangerConn.socket.emit('workspace:subscribe', { workspaceId: workspace._id }, resolve)
    );
    expect(denial).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
      error: 'Not a member of this workspace',
    });
    expect(roomMembers(`ws:${workspace._id}`).has(strangerConn.socket.id)).toBe(false);

    const memberConn = connect(port, authCookie(member));
    await memberConn.hello;
    open.push(memberConn.socket);

    const granted = await new Promise((resolve) =>
      memberConn.socket.emit('workspace:subscribe', { workspaceId: workspace._id }, resolve)
    );
    expect(granted).toEqual({ ok: true, room: `ws:${workspace._id}` });
    expect(roomMembers(`ws:${workspace._id}`).has(memberConn.socket.id)).toBe(true);

    memberConn.socket.close();
    strangerConn.socket.close();
  });

  it('emits presence events for workspace members', async () => {
    const ownerConn = connect(port, authCookie(owner));
    await ownerConn.hello;
    open.push(ownerConn.socket);

    const cameOnline = waitFor(
      ownerConn.socket,
      'presence:online',
      (e) => e.userId === member.user.id
    );
    const memberConn = connect(port, authCookie(member));
    await memberConn.hello;
    const online = await cameOnline;
    expect(online.workspaceId).toBe(workspace._id);

    const wentOffline = waitFor(
      ownerConn.socket,
      'presence:offline',
      (e) => e.userId === member.user.id
    );
    memberConn.socket.close();
    const offline = await wentOffline;
    expect(offline.workspaceId).toBe(workspace._id);

    ownerConn.socket.close();
  });

  it('fans every broadcast out through Redis pub/sub (multi-instance ready)', async () => {
    const io = getIO();
    // The Redis adapter is a factory function; Socket.io's default in-memory
    // adapter is an object instance. That structural difference is what makes
    // `io.to(room).emit()` reach sockets held by *other* app instances.
    expect(typeof io.adapter).toBe('function');

    // eslint-disable-next-line global-require
    const MemoryRedis = require('../src/config/memoryRedis');
    const channels = [];
    const original = MemoryRedis.prototype.publish;
    MemoryRedis.prototype.publish = function spy(channel, message) {
      channels.push(channel);
      return original.call(this, channel, message);
    };

    try {
      const { socket, hello } = connect(port, authCookie(owner));
      await hello;
      const received = waitFor(socket, 'adapter:test');
      io.to(`ws:${workspace._id}`).emit('adapter:test', { ok: true });
      expect(await received).toEqual({ ok: true });
      // The adapter hands the packet to Redis on its own schedule (the local
      // delivery does not await the publish), so give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(channels.length).toBeGreaterThan(0);
      socket.close();
    } finally {
      MemoryRedis.prototype.publish = original;
    }
  });
});
