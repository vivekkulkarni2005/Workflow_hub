'use strict';

const { agent, registerUser, createWorkspace, addMember, createTask, resetRedis } = require('./helpers');

describe('authorization', () => {
  let owner;
  let admin;
  let member;
  let stranger;
  let workspace;

  beforeEach(async () => {
    await resetRedis();
    owner = await registerUser({ name: 'Owner' });
    admin = await registerUser({ name: 'Admin' });
    member = await registerUser({ name: 'Member' });
    stranger = await registerUser({ name: 'Stranger' });
    workspace = (await createWorkspace(owner.bearer, 'RBAC Corp')).workspace;

    await addMember(workspace._id, owner.bearer, admin.user.id, 'admin');
    await addMember(workspace._id, owner.bearer, member.user.id, 'member');
  });

  describe('authentication gate', () => {
    it('401s an unauthenticated read', async () => {
      await agent().get(`/api/v1/workspaces/${workspace._id}`).expect(401);
    });

    it('401s a tampered token', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}`)
        .set('Authorization', `${owner.bearer}tampered`);
      expect(res.status).toBe(401);
    });
  });

  describe('membership gate', () => {
    it('403s a non-member', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}`)
        .set('Authorization', stranger.bearer);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_A_MEMBER');
    });

    it('does not list the workspace for a non-member', async () => {
      const res = await agent()
        .get('/api/v1/workspaces')
        .set('Authorization', stranger.bearer)
        .expect(200);
      expect(res.body.items).toHaveLength(0);
    });

    it('404s a workspace that does not exist', async () => {
      const res = await agent()
        .get('/api/v1/workspaces/64b7f0f0f0f0f0f0f0f0f0f0')
        .set('Authorization', owner.bearer);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WORKSPACE_NOT_FOUND');
    });

    it('lets a plain member read the workspace', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}`)
        .set('Authorization', member.bearer);
      expect(res.status).toBe(200);
      expect(res.body.workspace.members.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('role gate (admin/owner only)', () => {
    it('lets a member create a task', async () => {
      const res = await agent()
        .post(`/api/v1/workspaces/${workspace._id}/tasks`)
        .set('Authorization', member.bearer)
        .send({ title: 'member task' });
      expect(res.status).toBe(201);
      expect(res.body.task.createdBy).toBe(member.user.id);
    });

    it('forbids a member from patching a task', async () => {
      const task = await createTask(owner.bearer, workspace._id, { title: 'x' });
      const res = await agent()
        .patch(`/api/v1/workspaces/${workspace._id}/tasks/${task._id}`)
        .set('Authorization', member.bearer)
        .send({ status: 'done' });
      expect(res.status).toBe(403);
    });

    it('forbids a member from adding members', async () => {
      const res = await agent()
        .post(`/api/v1/workspaces/${workspace._id}/members`)
        .set('Authorization', member.bearer)
        .send({ userId: stranger.user.id, role: 'admin' });
      expect(res.status).toBe(403);
    });

    it('lets an admin create and patch tasks', async () => {
      const created = await agent()
        .post(`/api/v1/workspaces/${workspace._id}/tasks`)
        .set('Authorization', admin.bearer)
        .send({ title: 'admin task' })
        .expect(201);
      const patched = await agent()
        .patch(`/api/v1/workspaces/${workspace._id}/tasks/${created.body.task._id}`)
        .set('Authorization', admin.bearer)
        .send({ status: 'doing' })
        .expect(200);
      expect(patched.body.task.status).toBe('doing');
    });

    it('forbids an admin from deleting the workspace (owner only)', async () => {
      const res = await agent()
        .delete(`/api/v1/workspaces/${workspace._id}`)
        .set('Authorization', admin.bearer);
      expect(res.status).toBe(403);
    });

    it('lets the owner delete the workspace', async () => {
      await agent()
        .delete(`/api/v1/workspaces/${workspace._id}`)
        .set('Authorization', owner.bearer)
        .expect(204);
    });

    it('refuses to remove the owner from the workspace', async () => {
      const res = await agent()
        .delete(`/api/v1/workspaces/${workspace._id}/members/${owner.user.id}`)
        .set('Authorization', owner.bearer);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CANNOT_REMOVE_OWNER');
    });

    it('lets an admin remove a member and unassigns their tasks', async () => {
      const task = await createTask(owner.bearer, workspace._id, {
        title: 'assigned',
        assignee: member.user.id,
      });
      expect(task.assignee).toBe(member.user.id);

      await agent()
        .delete(`/api/v1/workspaces/${workspace._id}/members/${member.user.id}`)
        .set('Authorization', admin.bearer)
        .expect(200);

      const after = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks/${task._id}`)
        .set('Authorization', owner.bearer);
      expect(after.body.task.assignee).toBeNull();

      // and the removed member immediately loses access
      const denied = await agent()
        .get(`/api/v1/workspaces/${workspace._id}`)
        .set('Authorization', member.bearer);
      expect(denied.status).toBe(403);
    });

    it('rejects a duplicate member with 409', async () => {
      const res = await agent()
        .post(`/api/v1/workspaces/${workspace._id}/members`)
        .set('Authorization', owner.bearer)
        .send({ userId: member.user.id, role: 'member' });
      expect(res.status).toBe(409);
    });
  });

  describe('NoSQL injection', () => {
    it('is neutralised by express-mongo-sanitize', async () => {
      // Without sanitization this would match the first user in the collection.
      const res = await agent()
        .post('/api/v1/auth/login')
        .send({ email: { $ne: 'nobody@example.com' }, password: { $ne: '' } })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
