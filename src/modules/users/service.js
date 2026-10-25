// Business logic for the users module.
import * as store from './store.js';

// Public profile for a username, or null if it doesn't exist.
// Later: add viewer flags (e.g. "do I follow them") and counts from the follows store here.
export async function getProfile(username) {
  return store.getProfileByUsername(username);
}

// The caller's own account (public profile fields plus email), or null if the user no longer exists.
export async function getMe(userId) {
  return store.getUserById(userId);
}

// Updates the caller's own profile. Only displayName and bio pass through, even though the store's
// updateUser can also change email, username and password; those changes belong to other flows.
// Returns the updated account, or null if the user no longer exists.
export async function updateProfile(userId, fields) {
  const changes = {};
  if (fields.displayName !== undefined) changes.displayName = fields.displayName;
  if (fields.bio !== undefined) changes.bio = fields.bio;
  return store.updateUser(userId, changes);
}
