// npm run db:seed: replaces all data in the database DATABASE_URL points at with a fake but realistic dataset:
// users, follows, and two weeks of posts, replies, quotes and a few deleted posts.
//
// - Repeatable: a fixed random seed means the same data every run.
// - Uses the app's store functions, so the data obeys the same rules and constraints as real data.
// - One transaction: it clears and inserts everything, or changes nothing.
// - Refuses to run in production.
//
// Every seeded account's password is PASSWORD below. Log in as `alice` to see a busy home timeline.
import bcrypt from 'bcrypt';
import config from '../src/config/index.js';
import { pool, withTransaction, truncateAllTables } from '../src/db/index.js';
import * as usersStore from '../src/modules/users/store.js';
import * as followsStore from '../src/modules/follows/store.js';
import * as postsStore from '../src/modules/posts/store.js';

if (config.env === 'production') {
  console.error('db:seed refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const PASSWORD = 'password123';
const SEED = 42; // change for a different (but still repeatable) dataset
const POST_COUNT = 150;
const DAYS = 14; // posts are spread over the last two weeks

// --- Repeatable randomness (mulberry32: a tiny seeded generator) ---

let state = SEED;
function random() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (items) => items[Math.floor(random() * items.length)];
const chance = (probability) => random() < probability;
function sample(items, count) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// --- Content ---

const USERS = [
  ['alice', 'Alice'],
  ['bob', 'Bob'],
  ['carol', 'Carol'],
  ['dave_codes', 'Dave'],
  ['erin', 'Erin'],
  ['frank_eats', 'Frank'],
  ['grace_h', 'Grace'],
  ['heidi', 'Heidi'],
  ['ivan_runs', 'Ivan'],
  ['judy', 'Judy'],
  ['mallory', 'Mallory'],
  ['niaj', 'Niaj'],
  ['olivia_art', 'Olivia'],
  ['peggy', 'Peggy'],
  ['rupert', 'Rupert'],
  ['sybil', 'Sybil'],
  ['trent', 'Trent'],
  ['victor_v', 'Victor'],
  ['walter', 'Walter'],
  ['xena_writes', 'Xena'],
];

const BIOS = [
  'Coffee first, opinions second.',
  'Building things on the internet.',
  'Runner, reader, occasional baker.',
  'Here for the hot takes.',
  'Photography and long walks.',
  'Professional overthinker.',
  'Plants, cats and terminal emulators.',
  null,
  null,
];

const POSTS = [
  'Just shipped a feature I have been working on for weeks. Feels good.',
  'Hot take: tabs are fine. Spaces are also fine. Pick one and move on.',
  'Made sourdough for the first time and it actually rose.',
  'Why does every meeting that could have been an email become two meetings?',
  'Morning run done. 5k in the rain, would not recommend, would do again.',
  'Reading a great book about distributed systems. My brain hurts in a good way.',
  'Today I learned Postgres timestamps have microsecond precision and JavaScript dates do not.',
  'The best debugging tool is still a good night of sleep.',
  'Anyone else think pineapple on pizza is genuinely good?',
  'Finally cleaned my desk. Found three pens and a mystery cable.',
  'Cursor pagination > offset pagination. Fight me.',
  'Coffee count today: too many.',
  'New houseplant. Naming it Kevin.',
  'Wrote tests before the code today. Felt very responsible.',
  'Sunsets this week have been unreal.',
  'Learning to draw again after ten years. Hands are hard.',
  'Weekend plan: absolutely nothing, and I am excited about it.',
  'Small wins: inbox zero for about four minutes.',
  'Tried a new ramen place. Ten out of ten, will be back tomorrow.',
  'Every app needs a dark mode and I will not be taking questions.',
  'Spent an hour naming a variable. Called it data.',
  'Started journaling. Day one entry: started journaling.',
  'Rain on the window, music on, code flowing. Perfect afternoon.',
  'Reminder to drink some water.',
];

const REPLIES = [
  'Totally agree with this.',
  'Hard disagree, but respect.',
  'This is the content I am here for.',
  'Same thing happened to me last week!',
  'Okay but have you tried turning it off and on again?',
  'Underrated take.',
  'I need to know more about this.',
  'Congrats, that is huge!',
  'Ha, relatable.',
  'Wait, really?',
  'Saving this for later.',
  'Strong opinions, loosely held. I like it.',
];

const QUOTES = [
  'This, so much this.',
  'Adding my two cents: yes.',
  'Everyone should read this.',
  'Respectfully, no.',
  'The real question is in the replies.',
  'Couldn’t have said it better.',
];

// --- Seeding ---

async function seed(db) {
  await truncateAllTables(db);

  // One hash for every account: seed data only, and it keeps seeding fast.
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const now = Date.now();
  const windowStart = now - DAYS * 24 * 60 * 60 * 1000;
  const randomTimeAfter = (start) => new Date(start + random() * (now - start));

  // Users, "joined" before the posting window.
  const users = [];
  for (const [username, displayName] of USERS) {
    const user = await usersStore.createUser(
      { username, email: `${username}@example.com`, passwordHash, displayName, bio: pick(BIOS) },
      db,
    );
    const joinedAt = new Date(windowStart - int(1, 60) * 24 * 60 * 60 * 1000);
    await db.query('UPDATE users SET created_at = $2, updated_at = $2 WHERE user_id = $1', [user.userId, joinedAt]);
    users.push(user);
  }

  // Follows: alice follows most people (a full home timeline); everyone else follows a handful.
  let followCount = 0;
  for (const user of users) {
    const others = users.filter((other) => other.userId !== user.userId);
    const count = user.username === 'alice' ? others.length - 3 : int(3, 8);
    for (const target of sample(others, count)) {
      await followsStore.follow(user.userId, target.userId, db);
      await db.query('UPDATE follows SET created_at = $3 WHERE follower_id = $1 AND followed_id = $2', [
        user.userId,
        target.userId,
        randomTimeAfter(windowStart),
      ]);
      followCount += 1;
    }
  }

  // Posts in time order, so a reply or quote always comes after the post it points at.
  const times = Array.from({ length: POST_COUNT }, () => randomTimeAfter(windowStart)).sort((a, b) => a - b);
  const posts = []; // { postId, rootPostId, authorId, createdAt }
  const counts = { originals: 0, replies: 0, quotes: 0, deleted: 0 };

  for (const createdAt of times) {
    const author = pick(users);
    const fields = { authorId: author.userId };

    if (posts.length > 0 && chance(0.3)) {
      // Reply, usually to something recent so conversations cluster.
      const parent = pick(posts.slice(-20));
      fields.content = pick(REPLIES);
      fields.parentPostId = parent.postId;
      fields.rootPostId = parent.rootPostId ?? parent.postId;
      counts.replies += 1;
    } else if (posts.length > 0 && chance(0.12)) {
      fields.content = pick(QUOTES);
      fields.quotedPostId = pick(posts).postId;
      counts.quotes += 1;
    } else {
      fields.content = pick(POSTS);
      counts.originals += 1;
    }

    const { postId } = await postsStore.createPost(fields, db);
    await db.query('UPDATE posts SET created_at = $2 WHERE post_id = $1', [postId, createdAt]);
    posts.push({ postId, rootPostId: fields.rootPostId ?? null, authorId: author.userId });
  }

  // A few deleted posts, so threads and quotes show the deleted state.
  for (const post of sample(posts, Math.round(posts.length * 0.03))) {
    await postsStore.softDeletePost(post.postId, post.authorId, db);
    counts.deleted += 1;
  }

  return { users: users.length, follows: followCount, ...counts };
}

const dbName = new URL(config.databaseUrl).pathname.slice(1);
try {
  const summary = await withTransaction(seed);
  console.log(`Seeded "${dbName}":`);
  console.log(`  ${summary.users} users, ${summary.follows} follows`);
  console.log(
    `  ${summary.originals} posts, ${summary.replies} replies, ${summary.quotes} quotes (${summary.deleted} deleted)`,
  );
  console.log(`Log in as any seeded user (e.g. alice) with password "${PASSWORD}".`);
} finally {
  await pool.end();
}
