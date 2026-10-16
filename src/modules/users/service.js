// Business logic for the users module.
import * as store from './store.js';

// Public profile for a username, or null if it doesn't exist.
// Later: add viewer flags (e.g. "do I follow them") and counts from the follows store here.
export async function getProfile(username) {
  return store.getProfileByUsername(username);
}
