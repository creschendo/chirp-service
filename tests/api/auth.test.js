// HTTP tests for the auth routes. Requests go through the real app and pool; tables are emptied between tests.
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { hashRefreshToken } from '../../src/modules/auth/tokens.js';
import { pool, resetDatabase } from '../helpers/db.js';
import { createUser } from '../helpers/factories.js';

afterEach(() => resetDatabase());
afterAll(() => pool.end());

const PASSWORD = 'correct horse battery';

// Low bcrypt cost keeps tests fast; compare() reads the cost from the hash, so login works the same.
async function createUserWithPassword(overrides = {}) {
  return createUser(pool, { passwordHash: await bcrypt.hash(PASSWORD, 4), ...overrides });
}

// Parses Set-Cookie headers into { name: { value, attributes } } (attribute names lowercased).
function cookiesFrom(res) {
  const cookies = {};
  for (const header of res.headers['set-cookie'] ?? []) {
    const [pair, ...attrs] = header.split(';').map((s) => s.trim());
    const [name, value] = pair.split('=');
    cookies[name] = {
      value,
      attributes: Object.fromEntries(
        attrs.map((a) => {
          const [k, v] = a.split('=');
          return [k.toLowerCase(), v ?? true];
        }),
      ),
    };
  }
  return cookies;
}

describe('POST /auth/refresh', () => {
  // Logs a fresh user in; returns the user and the raw cookie values.
  async function loggedIn() {
    const user = await createUserWithPassword();
    const res = await request(app).post('/auth/login').send({ login: user.username, password: PASSWORD });
    const cookies = cookiesFrom(res);
    return { user, access: cookies.access_token.value, refresh: cookies.refresh_token.value };
  }
  const refreshWith = (token) => {
    const req = request(app).post('/auth/refresh');
    return token === undefined ? req : req.set('Cookie', `refresh_token=${token}`);
  };
  const sessionFor = async (token) =>
    (
      await pool.query(
        'SELECT session_id, revoked_at, replaced_by_session_id FROM sessions WHERE refresh_token_hash = $1',
        [hashRefreshToken(token)],
      )
    ).rows[0];
  const activeSessions = async (userId) =>
    (await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]))
      .rows[0].n;
  const expectClearedCookies = (res) => {
    const cookies = cookiesFrom(res);
    expect(cookies.access_token.value).toBe('');
    expect(cookies.refresh_token.value).toBe('');
    expect(cookies.refresh_token.attributes.path).toBe('/auth');
  };

  test('204 with a new access and refresh token', async () => {
    const { user, refresh } = await loggedIn();
    const res = await refreshWith(refresh);
    expect(res.status).toBe(204);

    const cookies = cookiesFrom(res);
    expect(cookies.refresh_token.value).not.toBe(refresh);
    expect(cookies.refresh_token.attributes).toMatchObject({ httponly: true, path: '/auth' });
    const me = await request(app).get('/users/me').set('Cookie', `access_token=${cookies.access_token.value}`);
    expect(me.body.userId).toBe(user.userId);
  });

  test('rotates: the old session points at the new one', async () => {
    const { refresh } = await loggedIn();
    const res = await refreshWith(refresh);
    const next = cookiesFrom(res).refresh_token.value;

    const oldSession = await sessionFor(refresh);
    const newSession = await sessionFor(next);
    expect(oldSession.replaced_by_session_id).toBe(newSession.session_id);
    expect(oldSession.revoked_at).toBeNull();
    expect(newSession.replaced_by_session_id).toBeNull();
  });

  test('the new refresh token can refresh again', async () => {
    const { refresh } = await loggedIn();
    const first = await refreshWith(refresh);
    const second = await refreshWith(cookiesFrom(first).refresh_token.value);
    expect(second.status).toBe(204);
  });

  test('reusing a spent token revokes every session of the user (theft) and clears cookies', async () => {
    const { user, refresh } = await loggedIn();
    await loggedIn(); // another user's session must survive
    const rotated = await refreshWith(refresh);
    const stolenCopy = await refreshWith(refresh);

    expect(stolenCopy.status).toBe(401);
    expectClearedCookies(stolenCopy);
    expect(await activeSessions(user.userId)).toBe(0);
    // The legitimate client's newer token is dead too: everyone has to log in again.
    expect((await refreshWith(cookiesFrom(rotated).refresh_token.value)).status).toBe(401);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n).toBe(1);
  });

  test('two concurrent refreshes with the same token: one wins, the other counts as reuse', async () => {
    const { user, refresh } = await loggedIn();
    const results = await Promise.all([refreshWith(refresh), refreshWith(refresh)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 401]);
    expect(await activeSessions(user.userId)).toBe(0);
  });

  test('401 and cleared cookies for a revoked session', async () => {
    const { refresh } = await loggedIn();
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1', [hashRefreshToken(refresh)]);
    const res = await refreshWith(refresh);
    expect(res.status).toBe(401);
    expectClearedCookies(res);
  });

  test('401 for an expired session', async () => {
    const { refresh } = await loggedIn();
    await pool.query(
      `UPDATE sessions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
       WHERE refresh_token_hash = $1`,
      [hashRefreshToken(refresh)],
    );
    expect((await refreshWith(refresh)).status).toBe(401);
  });

  test('401 for a session whose user was deleted', async () => {
    const { user, refresh } = await loggedIn();
    await pool.query('DELETE FROM users WHERE user_id = $1', [user.userId]);
    expect((await refreshWith(refresh)).status).toBe(401);
  });

  test.each([
    ['no cookie', undefined],
    ['unknown token', 'not-a-real-token'],
  ])('401 for %s', async (_, token) => {
    const res = await refreshWith(token);
    expect(res.status).toBe(401);
    expectClearedCookies(res);
  });

  test('the access token is not accepted as a refresh token', async () => {
    const { access } = await loggedIn();
    expect((await refreshWith(access)).status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  async function loggedIn(user) {
    const res = await request(app).post('/auth/login').send({ login: user.username, password: PASSWORD });
    const cookies = cookiesFrom(res);
    return { access: cookies.access_token.value, refresh: cookies.refresh_token.value };
  }
  const logoutWith = (token) => {
    const req = request(app).post('/auth/logout');
    return token === undefined ? req : req.set('Cookie', `refresh_token=${token}`);
  };
  const revokedAt = async (token) =>
    (await pool.query('SELECT revoked_at FROM sessions WHERE refresh_token_hash = $1', [hashRefreshToken(token)]))
      .rows[0].revoked_at;

  test('204, revokes the session and clears both cookies', async () => {
    const user = await createUserWithPassword();
    const { refresh } = await loggedIn(user);
    const res = await logoutWith(refresh);

    expect(res.status).toBe(204);
    expect(await revokedAt(refresh)).toEqual(expect.any(Date));
    const cookies = cookiesFrom(res);
    expect(cookies.access_token).toMatchObject({ value: '', attributes: { path: '/' } });
    expect(cookies.refresh_token).toMatchObject({ value: '', attributes: { path: '/auth' } });
  });

  test('the refresh token no longer works afterwards', async () => {
    const user = await createUserWithPassword();
    const { refresh } = await loggedIn(user);
    await logoutWith(refresh);
    expect((await request(app).post('/auth/refresh').set('Cookie', `refresh_token=${refresh}`)).status).toBe(401);
  });

  test('only ends this device: another session of the same user keeps working', async () => {
    const user = await createUserWithPassword();
    const phone = await loggedIn(user);
    const laptop = await loggedIn(user);
    await logoutWith(phone.refresh);
    expect(await revokedAt(laptop.refresh)).toBeNull();
    expect((await request(app).post('/auth/refresh').set('Cookie', `refresh_token=${laptop.refresh}`)).status).toBe(
      204,
    );
  });

  test('an already-issued access token still works until it expires (stateless)', async () => {
    const user = await createUserWithPassword();
    const { access, refresh } = await loggedIn(user);
    await logoutWith(refresh);
    expect((await request(app).get('/users/me').set('Cookie', `access_token=${access}`)).status).toBe(200);
  });

  test('a spent (rotated) token revokes all of the user\'s sessions', async () => {
    const user = await createUserWithPassword();
    const { refresh } = await loggedIn(user);
    const other = await loggedIn(user);
    await request(app).post('/auth/refresh').set('Cookie', `refresh_token=${refresh}`);

    expect((await logoutWith(refresh)).status).toBe(204);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL');
    expect(rows[0].n).toBe(0);
    expect(await revokedAt(other.refresh)).toEqual(expect.any(Date));
  });

  test.each([
    ['no cookie', undefined],
    ['unknown token', 'not-a-real-token'],
  ])('204 and cleared cookies with %s', async (_, token) => {
    const res = await logoutWith(token);
    expect(res.status).toBe(204);
    expect(cookiesFrom(res).refresh_token.value).toBe('');
  });

  test('logging out twice is fine', async () => {
    const user = await createUserWithPassword();
    const { refresh } = await loggedIn(user);
    await logoutWith(refresh);
    expect((await logoutWith(refresh)).status).toBe(204);
  });
});

describe('POST /auth/register', () => {
  const body = (overrides = {}) => ({
    username: 'new_user',
    email: 'New.User@Example.com',
    password: PASSWORD,
    ...overrides,
  });
  const countUsers = async () => (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;

  test('201 with the created account; displayName defaults to the username', async () => {
    const res = await request(app).post('/auth/register').send(body());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      userId: expect.any(String),
      username: 'new_user',
      email: 'New.User@Example.com',
      displayName: 'new_user',
      bio: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  test('uses displayName when given (trimmed)', async () => {
    const res = await request(app).post('/auth/register').send(body({ displayName: '  New User  ' }));
    expect(res.body.displayName).toBe('New User');
  });

  test('stores a bcrypt hash of the password, never the password', async () => {
    await request(app).post('/auth/register').send(body());
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).not.toBe(PASSWORD);
    expect(rows[0].password_hash).toMatch(/^\$2b\$12\$/);
    expect(await bcrypt.compare(PASSWORD, rows[0].password_hash)).toBe(true);
  });

  test('logs you in: same cookies as login, a session, and /users/me works', async () => {
    const res = await request(app).post('/auth/register').send(body());
    const cookies = cookiesFrom(res);
    expect(cookies.access_token.attributes).toMatchObject({ httponly: true, path: '/' });
    expect(cookies.refresh_token.attributes).toMatchObject({ httponly: true, path: '/auth' });

    const { rows } = await pool.query('SELECT refresh_token_hash FROM sessions');
    expect(rows).toEqual([{ refresh_token_hash: hashRefreshToken(cookies.refresh_token.value) }]);

    const me = await request(app).get('/users/me').set('Cookie', `access_token=${cookies.access_token.value}`);
    expect(me.body.userId).toBe(res.body.userId);
  });

  test('the new account can log in with its password', async () => {
    await request(app).post('/auth/register').send(body());
    const res = await request(app).post('/auth/login').send({ login: 'new.user@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  test('409 for a taken username, ignoring case; no second user, no cookies', async () => {
    await request(app).post('/auth/register').send(body());
    const res = await request(app)
      .post('/auth/register')
      .send(body({ username: 'NEW_USER', email: 'other@example.com' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Username is already taken' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await countUsers()).toBe(1);
  });

  test('409 for a taken email, ignoring case', async () => {
    await request(app).post('/auth/register').send(body());
    const res = await request(app)
      .post('/auth/register')
      .send(body({ username: 'other_user', email: 'NEW.USER@EXAMPLE.COM' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Email is already registered' });
  });

  test.each([
    ['no body', undefined],
    ['missing username', { email: 'a@example.com', password: PASSWORD }],
    ['username too short', body({ username: 'ab' })],
    ['username with invalid characters', body({ username: 'bad-name' })],
    ['invalid email', body({ email: 'not-an-email' })],
    ['password under 8 characters', body({ password: 'short' })],
    ['password over 72 bytes', body({ password: 'x'.repeat(73) })],
    ['multi-byte password over 72 bytes', body({ password: 'é'.repeat(37) })],
    ['blank displayName', body({ displayName: '   ' })],
    ['displayName over 50', body({ displayName: 'x'.repeat(51) })],
    ['unknown field', body({ bio: 'sneaky' })],
  ])('400 for %s, and nothing is created', async (_, payload) => {
    const req = request(app).post('/auth/register');
    const res = payload === undefined ? await req : await req.send(payload);
    expect(res.status).toBe(400);
    expect(await countUsers()).toBe(0);
  });
});

describe('POST /auth/login', () => {
  test('200 with the account, never the password hash', async () => {
    const user = await createUserWithPassword({ username: 'login_user' });
    const res = await request(app).post('/auth/login').send({ login: 'login_user', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: user.userId, username: 'login_user', email: user.email });
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  test('accepts username or email, ignoring case', async () => {
    const user = await createUserWithPassword({ username: 'Case_Login' });
    for (const login of ['case_login', 'CASE_LOGIN', user.email.toUpperCase()]) {
      const res = await request(app).post('/auth/login').send({ login, password: PASSWORD });
      expect(res.status).toBe(200);
    }
  });

  test('sets httpOnly access and refresh cookies with the right paths', async () => {
    await createUserWithPassword({ username: 'cookie_user' });
    const res = await request(app).post('/auth/login').send({ login: 'cookie_user', password: PASSWORD });
    const { access_token: access, refresh_token: refresh } = cookiesFrom(res);

    expect(access.attributes).toMatchObject({ httponly: true, path: '/', 'max-age': '900', samesite: 'Lax' });
    expect(refresh.attributes).toMatchObject({ httponly: true, path: '/auth', samesite: 'Lax' });
    expect(refresh.attributes).toHaveProperty('expires');
    // Not over HTTPS outside production.
    expect(access.attributes).not.toHaveProperty('secure');
  });

  test('the access cookie works for authenticated routes', async () => {
    const user = await createUserWithPassword({ username: 'then_me' });
    const login = await request(app).post('/auth/login').send({ login: 'then_me', password: PASSWORD });
    const access = cookiesFrom(login).access_token.value;

    const me = await request(app).get('/users/me').set('Cookie', `access_token=${access}`);
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(user.userId);
  });

  test('creates a session storing only the hash of the refresh token', async () => {
    const user = await createUserWithPassword({ username: 'sess_user' });
    const res = await request(app).post('/auth/login').send({ login: 'sess_user', password: PASSWORD });
    const refresh = cookiesFrom(res).refresh_token.value;

    const { rows } = await pool.query('SELECT user_id, refresh_token_hash, expires_at FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(user.userId);
    expect(rows[0].refresh_token_hash).toBe(hashRefreshToken(refresh));
    expect(rows[0].refresh_token_hash).not.toBe(refresh);
    expect(rows[0].expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  test('each login creates a separate session', async () => {
    await createUserWithPassword({ username: 'two_logins' });
    await request(app).post('/auth/login').send({ login: 'two_logins', password: PASSWORD });
    await request(app).post('/auth/login').send({ login: 'two_logins', password: PASSWORD });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0].n).toBe(2);
  });

  test('401 with the same message for a wrong password and an unknown login; no cookies, no session', async () => {
    await createUserWithPassword({ username: 'real_user' });
    const wrongPassword = await request(app).post('/auth/login').send({ login: 'real_user', password: 'nope' });
    const unknownUser = await request(app).post('/auth/login').send({ login: 'ghost_user', password: PASSWORD });

    for (const res of [wrongPassword, unknownUser]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid credentials' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0].n).toBe(0);
  });

  test.each([
    ['no body', undefined],
    ['missing password', { login: 'someone' }],
    ['missing login', { password: PASSWORD }],
    ['empty login', { login: '   ', password: PASSWORD }],
    ['empty password', { login: 'someone', password: '' }],
    ['non-string fields', { login: 1, password: 2 }],
    ['password over 128 chars', { login: 'someone', password: 'x'.repeat(129) }],
  ])('400 for %s', async (_, body) => {
    const req = request(app).post('/auth/login');
    const res = body === undefined ? await req : await req.send(body);
    expect(res.status).toBe(400);
  });
});
