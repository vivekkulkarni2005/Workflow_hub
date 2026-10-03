'use strict';

const { agent, registerUser, cookieHeader, resetRedis } = require('./helpers');

describe('auth', () => {
  beforeEach(resetRedis);

  describe('POST /auth/register', () => {
    it('creates a user and sets HttpOnly auth cookies', async () => {
      const res = await agent().post('/api/v1/auth/register').send({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'Sup3rSecret!',
      });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
      expect(res.body.user.passwordHash).toBeUndefined();

      const cookies = res.headers['set-cookie'];
      const access = cookies.find((c) => c.startsWith('wf_access='));
      const refresh = cookies.find((c) => c.startsWith('wf_refresh='));

      expect(access).toMatch(/HttpOnly/i);
      expect(access).toMatch(/SameSite=Strict/i);
      expect(refresh).toMatch(/HttpOnly/i);
      // The refresh cookie is scoped to the auth routes only.
      expect(refresh).toMatch(/Path=\/api\/v1\/auth/i);
    });

    it('never returns the bcrypt hash', async () => {
      const res = await agent().post('/api/v1/auth/register').send({
        name: 'Grace Hopper',
        email: 'grace@example.com',
        password: 'Sup3rSecret!',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
    });

    it('rejects a weak password with 422 and field details', async () => {
      const res = await agent().post('/api/v1/auth/register').send({
        name: 'Weak',
        email: 'weak@example.com',
        password: 'short',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'body.password')).toBe(true);
    });

    it('rejects a duplicate email with 409', async () => {
      await agent()
        .post('/api/v1/auth/register')
        .send({ name: 'AA', email: 'dup@example.com', password: 'Sup3rSecret!' })
        .expect(201);
      const res = await agent()
        .post('/api/v1/auth/register')
        .send({ name: 'BB', email: 'dup@example.com', password: 'Sup3rSecret!' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });
  });

  describe('POST /auth/login', () => {
    it('authenticates with correct credentials', async () => {
      const { body } = await registerUser();
      const res = await agent()
        .post('/api/v1/auth/login')
        .send({ email: body.email, password: body.password });
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(body.email);
    });

    it('rejects a wrong password with a generic 401 (no user enumeration)', async () => {
      const { body } = await registerUser();
      const res = await agent()
        .post('/api/v1/auth/login')
        .send({ email: body.email, password: 'WrongPassword1' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('BAD_CREDENTIALS');
      expect(res.body.error.message).toBe('Invalid email or password');
    });

    it('returns the same message for an unknown email', async () => {
      const res = await agent()
        .post('/api/v1/auth/login')
        .send({ email: 'ghost@example.com', password: 'Sup3rSecret!' });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid email or password');
    });
  });

  describe('GET /auth/me', () => {
    it('works with the cookie', async () => {
      const { user, cookies } = await registerUser();
      const res = await agent().get('/api/v1/auth/me').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(user.id);
    });

    it('works with a bearer token', async () => {
      const { user, bearer } = await registerUser();
      const res = await agent().get('/api/v1/auth/me').set('Authorization', bearer);
      expect(res.body.user.id).toBe(user.id);
    });

    it('401s without credentials', async () => {
      const res = await agent().get('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('NO_TOKEN');
    });
  });

  describe('refresh rotation', () => {
    it('issues a new refresh token and invalidates the previous one', async () => {
      const { body } = await registerUser();
      const login = await agent()
        .post('/api/v1/auth/login')
        .send({ email: body.email, password: body.password });
      const firstRefresh = login.headers['set-cookie'].find((c) => c.startsWith('wf_refresh='));
      const oldRefresh = decodeURIComponent(firstRefresh.split(';')[0].split('=')[1]);

      const res = await agent().post('/api/v1/auth/refresh').set('Cookie', `wf_refresh=${oldRefresh}`);
      expect(res.status).toBe(200);
      const newRefresh = res.headers['set-cookie'].find((c) => c.startsWith('wf_refresh='));
      const newToken = decodeURIComponent(newRefresh.split(';')[0].split('=')[1]);
      expect(newToken).not.toBe(oldRefresh);
    });

    it('detects reuse of a rotated token and revokes the family', async () => {
      const { body } = await registerUser();
      const login = await agent()
        .post('/api/v1/auth/login')
        .send({ email: body.email, password: body.password });
      const oldRefresh = decodeURIComponent(
        login.headers['set-cookie'].find((c) => c.startsWith('wf_refresh=')).split(';')[0].split('=')[1]
      );

      // Legitimate rotation happens first.
      const rotated = await agent().post('/api/v1/auth/refresh').set('Cookie', `wf_refresh=${oldRefresh}`);
      const current = decodeURIComponent(
        rotated.headers['set-cookie'].find((c) => c.startsWith('wf_refresh=')).split(';')[0].split('=')[1]
      );

      // The attacker now replays the stolen (already rotated) token.
      const replay = await agent().post('/api/v1/auth/refresh').set('Cookie', `wf_refresh=${oldRefresh}`);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('REFRESH_REUSE');

      // ...which also kills the legitimate session.
      const afterBreach = await agent().post('/api/v1/auth/refresh').set('Cookie', `wf_refresh=${current}`);
      expect(afterBreach.status).toBe(401);
    });

    it('401s a garbage token', async () => {
      const res = await agent().post('/api/v1/auth/refresh').set('Cookie', 'wf_refresh=not-a-jwt');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('invalidates the refresh token and clears cookies', async () => {
      const { body } = await registerUser();
      const login = await agent()
        .post('/api/v1/auth/login')
        .send({ email: body.email, password: body.password });
      const cookies = cookieHeader(login);
      const refreshToken = decodeURIComponent(
        login.headers['set-cookie'].find((c) => c.startsWith('wf_refresh=')).split(';')[0].split('=')[1]
      );

      const res = await agent().post('/api/v1/auth/logout').set('Cookie', cookies);
      expect(res.status).toBe(204);
      expect(res.headers['set-cookie'].join(';')).toMatch(/wf_access=;/);

      const reuse = await agent().post('/api/v1/auth/refresh').set('Cookie', `wf_refresh=${refreshToken}`);
      expect(reuse.status).toBe(401);
    });
  });
});
