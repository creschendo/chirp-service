// Messages store: direct and group messages (milestone 6). Turn todos into tests as the store is built.

describe('direct conversations', () => {
  test.todo('find-or-create a one-to-one conversation; same pair returns the same conversation in either order');
  test.todo('concurrent find-or-create for the same pair yields one conversation');
  test.todo('cannot start a conversation with yourself (conversations_direct_pair_order)');
  test.todo('unknown user -> 23503');
});

describe('group conversations', () => {
  test.todo('create a group; the same members twice makes two groups');
  test.todo('add participants skips existing members and returns only the new ones');
  test.todo('remove participant; the last one out deletes the conversation');
  test.todo('name is rejected on a direct conversation and over 50 characters');
});

describe('inbox', () => {
  test.todo("list a user's conversations, most recent activity first, paginated, with the other participants");
  test.todo('a direct conversation with no messages is left out; an empty group is listed');
  test.todo('last message preview and unread count only count messages visible to the viewer');
});

describe('messages', () => {
  test.todo('send a message to a conversation you are part of');
  test.todo('list messages in a conversation, newest first, paginated');
  test.todo('a member added later only sees messages from their joined_at on');
  test.todo('a non-participant gets nothing (getMembership returns null)');
  test.todo('empty or over-length message is rejected by a constraint');
  test.todo('soft delete clears content; only the sender can delete');
});

describe('read state', () => {
  test.todo('mark read zeroes the unread count and never moves last_read_at backwards');
  test.todo("your own messages don't count as unread");
});

describe('deletes', () => {
  test.todo("deleting a user removes their participant rows and direct chats, and keeps their group messages with sender null");
});
