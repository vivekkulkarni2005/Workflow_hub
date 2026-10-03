'use strict';

const { agent, registerUser, createWorkspace, addMember, createTask, resetRedis } = require('./helpers');

describe('tasks', () => {
  let owner;
  let workspace;

  beforeEach(async () => {
    await resetRedis();
    owner = await registerUser();
    workspace = (await createWorkspace(owner.bearer, 'Task Corp')).workspace;
  });

  const post = (body) =>
    agent()
      .post(`/api/v1/workspaces/${workspace._id}/tasks`)
      .set('Authorization', owner.bearer)
      .send(body);

  describe('create', () => {
    it('creates a task with defaults', async () => {
      const res = await post({ title: 'Write the report' }).expect(201);
      expect(res.body.task).toMatchObject({
        title: 'Write the report',
        status: 'todo',
        priority: 'medium',
      });
      expect(res.body.task.workspace).toBe(workspace._id);
    });

    it('rejects an unknown field (strict schema)', async () => {
      const res = await post({ title: 'x', hacker: true });
      expect(res.status).toBe(422);
    });

    it('rejects an invalid status enum', async () => {
      const res = await post({ title: 'x', status: 'nonsense' });
      expect(res.status).toBe(422);
      expect(res.body.error.details[0].field).toBe('body.status');
    });

    it('rejects a non-member assignee', async () => {
      const stranger = await registerUser();
      const res = await post({ title: 'x', assignee: stranger.user.id });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');
    });

    it('accepts a member assignee', async () => {
      const mate = await registerUser();
      await addMember(workspace._id, owner.bearer, mate.user.id, 'member');
      const res = await post({ title: 'x', assignee: mate.user.id }).expect(201);
      expect(res.body.task.assignee).toBe(mate.user.id);
    });
  });

  describe('list, filter, sort, paginate', () => {
    let many = 0;

    beforeEach(async () => {
      const statuses = ['todo', 'doing', 'done'];
      const priorities = ['low', 'medium', 'high', 'urgent'];
      // Bulk insert with the model directly: 30 tasks, deterministic ordering.
      for (let i = 0; i < 30; i += 1) {
        many = i;
        // eslint-disable-next-line no-await-in-loop
        await post({
          title: `Task ${String(i).padStart(2, '0')}`,
          status: statuses[i % 3],
          priority: priorities[i % 4],
        }).expect(201);
      }
      expect(many).toBe(29);
    });

    it('filters by status', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?status=doing`)
        .set('Authorization', owner.bearer)
        .expect(200);
      expect(res.body.items.length).toBe(10);
      expect(res.body.items.every((t) => t.status === 'doing')).toBe(true);
    });

    it('filters by several statuses at once', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?status=todo&status=done`)
        .set('Authorization', owner.bearer);
      expect(res.body.items.length).toBe(20);
    });

    it('filters by priority', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?priority=urgent`)
        .set('Authorization', owner.bearer);
      expect(res.body.items.every((t) => t.priority === 'urgent')).toBe(true);
      expect(res.body.items.length).toBeGreaterThan(0);
    });

    it('never leaks tasks from another workspace', async () => {
      const other = await registerUser();
      const otherWs = (await createWorkspace(other.bearer, 'Other Co')).workspace;
      await createTask(other.bearer, otherWs._id, { title: 'Secret' });

      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks`)
        .set('Authorization', owner.bearer);
      expect(res.body.items.every((t) => t.title !== 'Secret')).toBe(true);
    });

    it('sorts by dueDate ascending', async () => {
      await createTask(owner.bearer, workspace._id, { title: 'late', dueDate: '2030-01-01' });
      await createTask(owner.bearer, workspace._id, { title: 'soon', dueDate: '2020-01-01' });
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?sort=dueDate`)
        .set('Authorization', owner.bearer);
      const dates = res.body.items.filter((t) => t.dueDate).map((t) => new Date(t.dueDate).getTime());
      expect(dates).toEqual([...dates].sort((a, b) => a - b));
    });

    it('paginates with an opaque cursor and never repeats a row', async () => {
      const seen = new Set();
      let cursor = null;
      let pages = 0;

      do {
        const url = `/api/v1/workspaces/${workspace._id}/tasks?limit=7${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await agent().get(url).set('Authorization', owner.bearer).expect(200);
        // eslint-disable-next-line no-await-in-loop
        res.body.items.forEach((t) => seen.add(t._id));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(5); // 30 tasks / 7 per page
      expect(seen.size).toBe(30);
    });

    it('rejects a malformed cursor', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?cursor=zzzz`)
        .set('Authorization', owner.bearer);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it('refuses a cursor that belongs to a different sort', async () => {
      // A createdAt cursor cannot be replayed against sort=dueDate: the
      // continuation predicate would describe a different ordering.
      const first = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?limit=5&sort=createdAt`)
        .set('Authorization', owner.bearer)
        .expect(200);
      const cursor = first.body.nextCursor;
      expect(cursor).toBeTruthy();

      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?limit=5&sort=dueDate&cursor=${cursor}`)
        .set('Authorization', owner.bearer);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CURSOR_SORT_MISMATCH');
    });

    it('paginates a non-default sort without repeating or dropping a row', async () => {
      const seen = new Set();
      let cursor = null;
      let pages = 0;

      do {
        const url =
          `/api/v1/workspaces/${workspace._id}/tasks?limit=4&sort=priority` +
          (cursor ? `&cursor=${cursor}` : '');
        const res = await agent().get(url).set('Authorization', owner.bearer).expect(200);
        // eslint-disable-next-line no-await-in-loop
        res.body.items.forEach((t) => seen.add(t._id));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);

      expect(pages).toBeGreaterThan(1);
      expect(seen.size).toBe(30);
    });

    it('caps the limit at 100', async () => {
      const res = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks?limit=9999`)
        .set('Authorization', owner.bearer);
      expect(res.status).toBe(422);
    });
  });

  describe('update / delete', () => {
    it('updates a task and stamps completedAt', async () => {
      const task = await createTask(owner.bearer, workspace._id, { title: 'Old title' });
      const res = await agent()
        .patch(`/api/v1/workspaces/${workspace._id}/tasks/${task._id}`)
        .set('Authorization', owner.bearer)
        .send({ status: 'done' })
        .expect(200);
      expect(res.body.task.status).toBe('done');
      expect(res.body.task.completedAt).toBeTruthy();
    });

    it('clears completedAt when moved back to todo', async () => {
      const task = await createTask(owner.bearer, workspace._id, { title: 'x', status: 'done' });
      const res = await agent()
        .patch(`/api/v1/workspaces/${workspace._id}/tasks/${task._id}`)
        .set('Authorization', owner.bearer)
        .send({ status: 'todo' })
        .expect(200);
      expect(res.body.task.completedAt).toBeNull();
    });

    it('404s an unknown task id', async () => {
      const res = await agent()
        .patch(`/api/v1/workspaces/${workspace._id}/tasks/64b7f0f0f0f0f0f0f0f0f0f0`)
        .set('Authorization', owner.bearer)
        .send({ title: 'nope' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    it('deletes a task', async () => {
      const task = await createTask(owner.bearer, workspace._id, { title: 'bye' });
      await agent()
        .delete(`/api/v1/workspaces/${workspace._id}/tasks/${task._id}`)
        .set('Authorization', owner.bearer)
        .expect(204);
      const list = await agent()
        .get(`/api/v1/workspaces/${workspace._id}/tasks`)
        .set('Authorization', owner.bearer);
      expect(list.body.items).toHaveLength(0);
    });
  });

  describe('reports', () => {
    it('aggregates open/overdue tasks per assignee and caches the result', async () => {
      const mate = await registerUser();
      await addMember(workspace._id, owner.bearer, mate.user.id, 'member');

      await createTask(owner.bearer, workspace._id, { title: 'a', assignee: mate.user.id });
      await createTask(owner.bearer, workspace._id, { title: 'b', assignee: mate.user.id });
      await createTask(owner.bearer, workspace._id, {
        title: 'c',
        assignee: mate.user.id,
        dueDate: '2000-01-01',
      });
      await createTask(owner.bearer, workspace._id, { title: 'd', status: 'done', assignee: mate.user.id });

      const url = `/api/v1/workspaces/${workspace._id}/reports`;
      const first = await agent().get(url).set('Authorization', owner.bearer).expect(200);
      expect(first.body.cached).toBe(false);
      expect(first.body.totals).toEqual({ open: 3, overdue: 1, urgent: 0 });
      expect(first.body.rows[0]).toMatchObject({ name: mate.user.name, open: 3, overdue: 1 });

      const second = await agent().get(url).set('Authorization', owner.bearer).expect(200);
      expect(second.body.cached).toBe(true); // served from Redis
    });

    it('invalidates the cached report when a task changes', async () => {
      const mate = await registerUser();
      await addMember(workspace._id, owner.bearer, mate.user.id, 'member');
      const url = `/api/v1/workspaces/${workspace._id}/reports`;

      await agent().get(url).set('Authorization', owner.bearer).expect(200);
      await createTask(owner.bearer, workspace._id, { title: 'new', assignee: mate.user.id });

      const after = await agent().get(url).set('Authorization', owner.bearer);
      expect(after.body.cached).toBe(false); // cache was dropped by the write
      expect(after.body.totals.open).toBe(1);
    });
  });
});
