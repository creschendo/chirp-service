// HTTP tests for the users routes. Requests go through the real app and pool, so data is committed;
// tables are emptied between tests.
import request from 'supertest';
import app from '../../src/app.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

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
  test.todo('200 with the account shape (public fields plus email) when logged in');
  test.todo('401 without an access token');
  test.todo('is not matched as a username by /:username (route order)');
});

describe('PATCH /users/me', () => {
  test.todo('updates displayName and bio, returns the updated profile');
  test.todo('partial update leaves other fields alone; bio: null clears bio');
  test.todo('400 for empty body, unknown fields, or values over the length limits');
  test.todo('401 without an access token');
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
