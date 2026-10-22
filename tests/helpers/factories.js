// Factories for test data. Each call gets unique values; pass overrides for the fields a test cares about.
// `db` is a transaction client (store tests) or the pool (API tests).
import * as usersStore from '../../src/modules/users/store.js';
import * as authStore from '../../src/modules/auth/store.js';

let seq = 0;
const next = () => {
  seq += 1;
  return seq;
};

export const daysFromNow = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

// Not a real bcrypt hash; store tests never verify passwords.
export async function createUser(db, overrides = {}) {
  const n = next();
  const username = overrides.username ?? `user_${n}`;
  return usersStore.createUser(
    {
      username,
      email: `${username}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: `User ${n}`,
      ...overrides,
    },
    db,
  );
}

export async function createSession(db, userId, overrides = {}) {
  return authStore.createSession(
    {
      userId,
      refreshTokenHash: `token_hash_${next()}`,
      expiresAt: daysFromNow(30),
      ...overrides,
    },
    db,
  );
}
