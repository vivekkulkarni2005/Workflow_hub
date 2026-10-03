'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { getClient } = require('../src/config/redis');

const app = createApp();
const agent = () => request(app);

/** Registers a user; returns the user, its password and ready-to-use credentials. */
async function registerUser(overrides = {}) {
  const body = {
    name: 'Test User',
    email: `user${Date.now()}${Math.random().toString(16).slice(2, 6)}@example.com`,
    password: 'Sup3rSecret!',
    ...overrides,
  };
  const res = await agent().post('/api/v1/auth/register').send(body).expect(201);
  return {
    user: res.body.user,
    body,
    cookies: cookieHeader(res),
    accessToken: extractAccess(res),
    bearer: bearer(res),
  };
}

function extractAccess(res) {
  const raw = res.headers['set-cookie'] || [];
  const entry = raw.find((c) => c.startsWith('wf_access='));
  return entry ? decodeURIComponent(entry.split(';')[0].split('=')[1]) : null;
}

function bearer(res) {
  return `Bearer ${extractAccess(res)}`;
}

/** Turns supertest's set-cookie array into a single Cookie request header. */
function cookieHeader(res) {
  const raw = res.headers['set-cookie'] || [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

/** Creates a workspace and returns it plus the caller's auth header. */
async function createWorkspace(authHeader, name = 'Acme') {
  const res = await agent()
    .post('/api/v1/workspaces')
    .set('Authorization', authHeader)
    .send({ name, description: 'test workspace' })
    .expect(201);
  return { workspace: res.body.workspace, authHeader };
}

/** Adds `userBearer` to `workspace` in the given role. */
async function addMember(workspaceId, ownerBearer, userId, role = 'member') {
  return agent()
    .post(`/api/v1/workspaces/${workspaceId}/members`)
    .set('Authorization', ownerBearer)
    .send({ userId, role })
    .expect(201);
}

/** Creates a task in `workspaceId`. */
async function createTask(authHeader, workspaceId, body = {}) {
  const res = await agent()
    .post(`/api/v1/workspaces/${workspaceId}/tasks`)
    .set('Authorization', authHeader)
    .send({ title: 'Ship it', ...body })
    .expect(201);
  return res.body.task;
}

/** Wipes the keyspace between tests (the suite uses the in-process Redis). */
async function resetRedis() {
  const client = getClient();
  if (!client) return;
  if (client.store) {
    client.store.clear();
    client.sets.clear();
  } else {
    await client.flushall();
  }
}

module.exports = {
  app,
  agent,
  registerUser,
  createWorkspace,
  addMember,
  createTask,
  cookieHeader,
  extractAccess,
  bearer,
  resetRedis,
};
