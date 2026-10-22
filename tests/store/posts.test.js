// Posts store (milestone 2; replies and quotes in milestone 4). Turn todos into tests as the store is built.

describe('create', () => {
  test.todo('creates an original post and returns it with author info');
  test.todo('empty or over-length content is rejected by a constraint');
  test.todo('creates a reply linked to its parent post');
  test.todo('reply to an unknown post -> 23503');
  test.todo('creates a quote post linked to the quoted post');
});

describe('read', () => {
  test.todo('get a single post by id with author info; unknown id -> null');
  test.todo('get a thread: a post and its replies in order');
  test.todo("list a user's posts, newest first, paginated");
});

describe('delete', () => {
  test.todo('author deletes own post -> true');
  test.todo("deleting someone else's post affects nothing (store filters by author)");
  test.todo('replies, quotes, likes and reposts of a deleted post are handled per your delete decision');
  test.todo('deleting a user removes or orphans their posts as designed');
});
