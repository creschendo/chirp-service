// Auth middleware, called directly with stand-in req/res objects. No database or HTTP needed.
import { ACCESS_TOKEN_COOKIE, optionalAuth, requireAuth } from '../../src/middleware/auth.js';
import { authCookie } from '../helpers/auth.js';

const USER_ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

// A request whose cookies are parsed the way cookie-parser leaves them: { name: value }.
function requestWith(cookieHeader) {
  if (!cookieHeader) {
    return { cookies: {} };
  }
  const [name, value] = cookieHeader.split('=');
  return { cookies: { [name]: value } };
}

// Runs the middleware and reports what it did: whether it called next(), and any response it sent.
function run(middleware, req) {
  const result = { nextCalled: false, status: null, body: null };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  middleware(req, res, () => {
    result.nextCalled = true;
  });
  return result;
}

const cases = [
  ['no cookie', null],
  ['a malformed token', `${ACCESS_TOKEN_COOKIE}=not-a-jwt`],
  ['an expired token', authCookie(USER_ID, { expiresIn: -1 })],
  ['a forged token', authCookie(USER_ID, { secret: 'not-the-real-secret' })],
];

describe('optionalAuth', () => {
  test('a valid token sets req.userId and continues', () => {
    const req = requestWith(authCookie(USER_ID));
    const result = run(optionalAuth, req);

    expect(result.nextCalled).toBe(true);
    expect(req.userId).toBe(USER_ID);
  });

  test.each(cases)('%s counts as logged out: req.userId is null and it continues, with no 401', (_, cookie) => {
    const req = requestWith(cookie);
    const result = run(optionalAuth, req);

    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeNull();
    expect(req.userId).toBeNull();
  });

  test('a request with no cookies object at all counts as logged out', () => {
    const req = {};
    expect(run(optionalAuth, req).nextCalled).toBe(true);
    expect(req.userId).toBeNull();
  });
});

describe('requireAuth (unchanged behavior after sharing the token check)', () => {
  test('a valid token sets req.userId and continues', () => {
    const req = requestWith(authCookie(USER_ID));
    const result = run(requireAuth, req);

    expect(result.nextCalled).toBe(true);
    expect(req.userId).toBe(USER_ID);
  });

  test.each(cases)('%s gets 401 and does not continue', (_, cookie) => {
    const req = requestWith(cookie);
    const result = run(requireAuth, req);

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Not logged in' });
    expect(req.userId).toBeUndefined();
  });
});
