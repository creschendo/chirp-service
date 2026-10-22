// Messages store: direct messages (milestone 6). Turn todos into tests as the store is built.

describe('conversations', () => {
  test.todo('find-or-create a one-to-one conversation; same pair returns the same conversation in either order');
  test.todo('cannot start a conversation with yourself');
  test.todo("list a user's conversations, most recent activity first, with the other participant's info");
});

describe('messages', () => {
  test.todo('send a message to a conversation you are part of');
  test.todo('list messages in a conversation, paginated');
  test.todo('a non-participant gets nothing (store filters by participant)');
  test.todo('empty or over-length message is rejected by a constraint');
});

describe('deletes', () => {
  test.todo('deleting a user handles their conversations and messages as designed');
});
