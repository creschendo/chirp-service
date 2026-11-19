// npm run db:seed: replaces all data in the database DATABASE_URL points at with a fake but realistic dataset:
// users, follows, two weeks of posts, replies, quotes and a few deleted posts, likes, reposts and bookmarks, direct
// and group conversations, and the notifications all of that would have created.
//
// - Repeatable: a fixed random seed means the same data every run.
// - Uses the app's store functions, so the data obeys the same rules and constraints as real data.
// - Every row is backdated to a time that makes sense: a like after its post, a reply after its parent, a message
//   after its sender joined the conversation.
// - One transaction: it clears and inserts everything, or changes nothing.
// - Refuses to run in production.
//
// Every seeded account's password is PASSWORD below. Log in as `alice` to see a busy home timeline, likes on her
// posts, unread notifications and a couple of unread conversations.
import bcrypt from 'bcrypt';
import config from '../src/config/index.js';
import { pool, withTransaction, truncateAllTables } from '../src/db/index.js';
import * as usersStore from '../src/modules/users/store.js';
import * as followsStore from '../src/modules/follows/store.js';
import * as postsStore from '../src/modules/posts/store.js';
import * as engagementStore from '../src/modules/engagement/store.js';
import * as messagesStore from '../src/modules/messages/store.js';
import * as notificationsStore from '../src/modules/notifications/store.js';

if (config.env === 'production') {
  console.error('db:seed refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const PASSWORD = 'password123';
const SEED = 42; // change for a different (but still repeatable) dataset
const POST_COUNT = 150;
const DAYS = 14; // posts are spread over the last two weeks
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// Notifications up to this long ago are read for alice, so she sees both read and unread ones.
const ALICE_NOTIFICATIONS_READ_AGO = 2 * DAY;

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

// Conversations, as scripts. Messages are [username, text], oldest first, a few minutes to an hour or so apart,
// starting `startDaysAgo` days ago. Everyone has read everything except alice, who hasn't read the last
// `aliceUnread` messages (all from others). `joinsLater` adds a member just before that message index, so the
// messages before it stay hidden from them. `deleted` is the index of a message its sender deleted.
const CONVERSATIONS = [
  {
    kind: 'direct',
    members: ['alice', 'bob'],
    startDaysAgo: 3,
    aliceUnread: 2,
    deleted: 4,
    messages: [
      ['bob', 'Did you see the new ramen place opened?'],
      ['alice', 'No! Where?'],
      ['bob', 'Corner of 5th and Main. Line was around the block.'],
      ['alice', 'Okay we are going this weekend.'],
      ['bob', 'Oops, wrong chat.'],
      ['alice', 'Saturday lunch?'],
      ['bob', 'Saturday works.'],
      ['bob', 'Actually can we do 1pm instead of noon?'],
      ['bob', 'Also bringing Carol if that is okay.'],
    ],
  },
  {
    kind: 'direct',
    members: ['alice', 'carol'],
    startDaysAgo: 6,
    aliceUnread: 0,
    messages: [
      ['alice', 'Thanks for reviewing my PR yesterday.'],
      ['carol', 'Of course. The cursor pagination part was really clean.'],
      ['alice', 'Took me three tries to get the tie-breaks right.'],
      ['carol', 'Worth it. Want to pair on the notifications work next week?'],
      ['alice', 'Yes please.'],
    ],
  },
  {
    kind: 'direct',
    members: ['bob', 'dave_codes'],
    startDaysAgo: 5,
    aliceUnread: 0,
    messages: [
      ['dave_codes', 'Is the deploy still happening today?'],
      ['bob', 'Pushed it to tomorrow, waiting on one more review.'],
      ['dave_codes', 'Makes sense. Ping me when it is out.'],
    ],
  },
  {
    kind: 'group',
    name: 'Weekend plans',
    members: ['alice', 'bob', 'erin', 'frank_eats'],
    startDaysAgo: 2,
    aliceUnread: 1,
    messages: [
      ['erin', 'Hike on Sunday? Weather looks good.'],
      ['frank_eats', 'I am in if there are snacks.'],
      ['alice', 'There are always snacks.'],
      ['bob', 'Count me in. 9am at the trailhead?'],
      ['erin', '9am works.'],
      ['frank_eats', 'I will bring the good trail mix.'],
    ],
  },
  {
    kind: 'group',
    name: 'Book club',
    members: ['alice', 'grace_h', 'heidi'],
    joinsLater: { username: 'olivia_art', before: 3 },
    startDaysAgo: 9,
    aliceUnread: 0,
    messages: [
      ['grace_h', 'Next pick: something about distributed systems?'],
      ['heidi', 'Only if it has pictures.'],
      ['alice', 'Designing Data-Intensive Applications has diagrams. Close enough.'],
      ['grace_h', 'Added Olivia, she asked to join.'],
      ['olivia_art', 'Hi all! Happy to be here.'],
      ['heidi', 'Welcome! We start chapter one on Monday.'],
    ],
  },
];

// --- Seeding ---

// One conversation from a script (see CONVERSATIONS). Uses the messages store, then backdates: members join at the
// start (or just before a later message), each message is a few minutes after the last, the inbox sort key is the
// newest message, and read state is set so only alice has anything unread.
async function seedConversation(script, usersByName, now, db) {
  const user = (username) => usersByName.get(username);
  const memberIds = script.members.map((username) => user(username).userId);
  const { conversationId } =
    script.kind === 'direct'
      ? await messagesStore.findOrCreateDirect(memberIds[0], memberIds[1], db)
      : await messagesStore.createGroup({ name: script.name }, db);
  await messagesStore.addParticipants(conversationId, memberIds, db);

  // Message times, oldest first.
  let at = now - script.startDaysAgo * DAY;
  const startedAt = new Date(at);
  const times = script.messages.map(() => {
    at += int(2, 90) * MINUTE;
    return new Date(at);
  });

  const joinedAt = new Map(script.members.map((username) => [username, startedAt]));
  if (script.joinsLater) {
    const { username, before } = script.joinsLater;
    joinedAt.set(username, new Date(times[before].getTime() - MINUTE));
    await messagesStore.addParticipants(conversationId, [user(username).userId], db);
  }

  const messageIds = [];
  for (const [i, [username, content]] of script.messages.entries()) {
    const message = await messagesStore.createMessage({ conversationId, senderId: user(username).userId, content }, db);
    await db.query('UPDATE messages SET created_at = $2 WHERE message_id = $1', [message.messageId, times[i]]);
    messageIds.push(message.messageId);
  }
  if (script.deleted !== undefined) {
    const [username] = script.messages[script.deleted];
    await messagesStore.softDeleteMessage(messageIds[script.deleted], user(username).userId, db);
  }

  const newest = times.at(-1);
  await db.query('UPDATE conversations SET created_at = $2, last_activity_at = $3 WHERE conversation_id = $1', [
    conversationId,
    startedAt,
    newest,
  ]);
  for (const [username, joined] of joinedAt) {
    // Everyone has read everything, except alice, who stopped just before her last `aliceUnread` messages.
    const unread = username === 'alice' ? script.aliceUnread : 0;
    const lastRead = unread > 0 ? new Date(times.at(-unread - 1).getTime() + 1) : newest;
    await db.query(
      `UPDATE conversation_participants SET joined_at = $3, last_read_at = $4
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, user(username).userId, joined, lastRead],
    );
  }
  return script.messages.length;
}

// Every notification the seeded actions would have created, built from the tables in one statement rather than one
// call per like, so each matches its source row and time exactly. Same rules as the app: likes, reposts, replies (to
// the direct parent's author), quotes and follows, never yourself. Returns { [type]: count }.
async function seedNotifications(db) {
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_id, actor_id, type, post_id, created_at)
     SELECT p.author_id, l.user_id, 'like', l.post_id, l.created_at
     FROM likes l JOIN posts p ON p.post_id = l.post_id
     WHERE l.user_id <> p.author_id
     UNION ALL
     SELECT p.author_id, r.user_id, 'repost', r.post_id, r.created_at
     FROM reposts r JOIN posts p ON p.post_id = r.post_id
     WHERE r.user_id <> p.author_id
     UNION ALL
     SELECT parent.author_id, p.author_id, 'reply', p.post_id, p.created_at
     FROM posts p JOIN posts parent ON parent.post_id = p.parent_post_id
     WHERE p.author_id <> parent.author_id
     UNION ALL
     SELECT quoted.author_id, p.author_id, 'quote', p.post_id, p.created_at
     FROM posts p JOIN posts quoted ON quoted.post_id = p.quoted_post_id
     WHERE p.author_id <> quoted.author_id
     UNION ALL
     SELECT f.followed_id, f.follower_id, 'follow', NULL, f.created_at
     FROM follows f
     RETURNING type`,
  );
  const counts = {};
  for (const { type } of rows) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

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
    posts.push({ postId, rootPostId: fields.rootPostId ?? null, authorId: author.userId, createdAt });
  }

  // Engagement, each at a random time after the post. Not by the post's own author (allowed, but not realistic as
  // seed data). alice's posts get a few extra likes, so her notifications fill up.
  const usersByName = new Map(users.map((user) => [user.username, user]));
  const alice = usersByName.get('alice');
  const othersThan = (authorId) => users.filter((user) => user.userId !== authorId);
  const engagement = { likes: 0, reposts: 0, bookmarks: 0 };

  for (const post of posts) {
    const likeCount = int(0, 6) + (post.authorId === alice.userId ? 3 : 0);
    for (const liker of sample(othersThan(post.authorId), likeCount)) {
      await engagementStore.addLike(liker.userId, post.postId, db);
      await db.query('UPDATE likes SET created_at = $3 WHERE user_id = $1 AND post_id = $2', [
        liker.userId,
        post.postId,
        randomTimeAfter(post.createdAt.getTime()),
      ]);
      engagement.likes += 1;
    }

    if (chance(0.12)) {
      for (const reposter of sample(othersThan(post.authorId), int(1, 3))) {
        await engagementStore.addRepost(reposter.userId, post.postId, db);
        await db.query('UPDATE reposts SET created_at = $3 WHERE user_id = $1 AND post_id = $2', [
          reposter.userId,
          post.postId,
          randomTimeAfter(post.createdAt.getTime()),
        ]);
        engagement.reposts += 1;
      }
    }
  }

  // Bookmarks: a dozen for alice (her bookmarks page), a few for everyone else.
  for (const user of users) {
    const count = user.userId === alice.userId ? 12 : int(0, 4);
    for (const post of sample(
      posts.filter((p) => p.authorId !== user.userId),
      count,
    )) {
      await engagementStore.addBookmark(user.userId, post.postId, db);
      await db.query('UPDATE bookmarks SET created_at = $3 WHERE user_id = $1 AND post_id = $2', [
        user.userId,
        post.postId,
        randomTimeAfter(post.createdAt.getTime()),
      ]);
      engagement.bookmarks += 1;
    }
  }

  // A few deleted posts, so threads and quotes show the deleted state. Their likes, reposts and notifications stay,
  // hidden, as they would in the app.
  for (const post of sample(posts, Math.round(posts.length * 0.03))) {
    await postsStore.softDeletePost(post.postId, post.authorId, db);
    counts.deleted += 1;
  }

  // Conversations and messages.
  let messageCount = 0;
  for (const script of CONVERSATIONS) {
    messageCount += await seedConversation(script, usersByName, now, db);
  }

  // Notifications last, built from everything above; alice has read the ones older than two days.
  const notifications = await seedNotifications(db);
  await notificationsStore.markReadUpTo(alice.userId, new Date(now - ALICE_NOTIFICATIONS_READ_AGO), db);
  const aliceUnread = await notificationsStore.countUnread(alice.userId, db);

  return {
    users: users.length,
    follows: followCount,
    ...counts,
    ...engagement,
    conversations: CONVERSATIONS.length,
    messages: messageCount,
    notifications,
    aliceUnread,
  };
}

const dbName = new URL(config.databaseUrl).pathname.slice(1);
try {
  const summary = await withTransaction(seed);
  console.log(`Seeded "${dbName}":`);
  console.log(`  ${summary.users} users, ${summary.follows} follows`);
  console.log(
    `  ${summary.originals} posts, ${summary.replies} replies, ${summary.quotes} quotes (${summary.deleted} deleted)`,
  );
  console.log(`  ${summary.likes} likes, ${summary.reposts} reposts, ${summary.bookmarks} bookmarks`);
  console.log(`  ${summary.conversations} conversations, ${summary.messages} messages`);
  const byType = Object.entries(summary.notifications)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  console.log(`  notifications: ${byType} (alice has ${summary.aliceUnread} unread)`);
  console.log(`Log in as any seeded user (e.g. alice) with password "${PASSWORD}".`);
} finally {
  await pool.end();
}
