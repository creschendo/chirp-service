// HTTP tests for the users routes. Requests go through the real app and pool, so data is committed;
// tables are emptied between tests.
import request from 'supertest';
import app from '../../src/app.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';
import { authCookie } from '../helpers/auth.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

describe('GET /users/:username', () => {
  test('200 with the public profile, ignoring case', async () => {
    const user = await createUser(pool, { username: 'Api_User', bio: 'hi' });
    const res = await request(app).get('/users/api_user');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: user.userId,
      username: 'Api_User',
      displayName: user.displayName,
      bio: 'hi',
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    });
  });

  test('never exposes email or password hash', async () => {
    await createUser(pool, { username: 'private_user' });
    const res = await request(app).get('/users/private_user');
    expect(res.body).not.toHaveProperty('email');
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  test('404 for an unknown username', async () => {
    const res = await request(app).get('/users/nobody_here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test('400 for an invalid username format', async () => {
    const res = await request(app).get('/users/a!');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid username');
  });

  test.todo('includes follower/following counts (once follows exists)');
});

describe('GET /users/me', () => {
  test('200 with the account shape (public fields plus email) when logged in', async () => {
    const user = await createUser(pool, { username: 'me_user' });
    const res = await request(app).get('/users/me').set('Cookie', authCookie(user.userId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...user,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    });
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  test('reflects changes made after the token was issued (reads the DB, not the token)', async () => {
    const user = await createUser(pool);
    const cookie = authCookie(user.userId);
    await pool.query(`UPDATE users SET email = 'changed@example.com' WHERE user_id = $1`, [user.userId]);
    const res = await request(app).get('/users/me').set('Cookie', cookie);
    expect(res.body.email).toBe('changed@example.com');
  });

  test.each([
    ['no token', null],
    ['expired token', (id) => authCookie(id, { expiresIn: -1 })],
    ['token signed with another secret', (id) => authCookie(id, { secret: 'not-the-secret' })],
    ['garbage token', () => 'access_token=not-a-jwt'],
  ])('401 with %s', async (_, makeCookie) => {
    const user = await createUser(pool);
    const req = request(app).get('/users/me');
    if (makeCookie) req.set('Cookie', makeCookie(user.userId));
    const res = await req;
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not logged in' });
  });

  test('404 when the token is valid but the user was deleted', async () => {
    const user = await createUser(pool);
    const cookie = authCookie(user.userId);
    await pool.query('DELETE FROM users WHERE user_id = $1', [user.userId]);
    const res = await request(app).get('/users/me').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /users/me', () => {
  test('updates displayName and bio, returns the updated account', async () => {
    const user = await createUser(pool);
    const res = await request(app)
      .patch('/users/me')
      .set('Cookie', authCookie(user.userId))
      .send({ displayName: 'New Name', bio: 'new bio' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: user.userId, displayName: 'New Name', bio: 'new bio', email: user.email });
  });

  test('partial update leaves other fields alone; bio: null clears bio', async () => {
    const user = await createUser(pool, { bio: 'old bio' });
    const cookie = authCookie(user.userId);

    const res1 = await request(app).patch('/users/me').set('Cookie', cookie).send({ displayName: 'Only Name' });
    expect(res1.body).toMatchObject({ displayName: 'Only Name', bio: 'old bio' });

    const res2 = await request(app).patch('/users/me').set('Cookie', cookie).send({ bio: null });
    expect(res2.body).toMatchObject({ displayName: 'Only Name', bio: null });
  });

  test('trims displayName', async () => {
    const user = await createUser(pool);
    const res = await request(app)
      .patch('/users/me')
      .set('Cookie', authCookie(user.userId))
      .send({ displayName: '  Spaced  ' });
    expect(res.body.displayName).toBe('Spaced');
  });

  test.each([
    ['empty body', {}],
    ['unknown field', { email: 'sneaky@example.com' }],
    ['username change attempt', { username: 'new_name' }],
    ['blank displayName', { displayName: '   ' }],
    ['displayName over 50', { displayName: 'x'.repeat(51) }],
    ['bio over 160', { bio: 'x'.repeat(161) }],
    ['wrong type', { displayName: 42 }],
  ])('400 for %s, and nothing changes', async (_, body) => {
    const user = await createUser(pool);
    const res = await request(app).patch('/users/me').set('Cookie', authCookie(user.userId)).send(body);
    expect(res.status).toBe(400);
    const { rows } = await pool.query('SELECT email, username, display_name FROM users WHERE user_id = $1', [
      user.userId,
    ]);
    expect(rows[0]).toEqual({ email: user.email, username: user.username, display_name: user.displayName });
  });

  test('401 without an access token', async () => {
    const res = await request(app).patch('/users/me').send({ displayName: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('app-level behavior', () => {
  test('unknown route -> 404 JSON', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('malformed JSON body -> 400 JSON', async () => {
    const res = await request(app).post('/users/x').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
