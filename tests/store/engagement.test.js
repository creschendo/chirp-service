// Engagement store: likes, reposts, bookmarks (milestone 4). Turn todos into tests as the store is built.

describe('likes', () => {
  test.todo('like is idempotent; second like returns false');
  test.todo('unlike is idempotent');
  test.todo('liking an unknown post -> 23503');
  test.todo('like count per post');
  test.todo('"I liked this" flag for a viewer across a list of posts');
  test.todo("list a user's likes, newest first, paginated");
});

describe('reposts', () => {
  test.todo('repost is idempotent; un-repost is idempotent');
  test.todo('repost count per post');
  test.todo('cannot repost your own post (if you decide to disallow it)');
});

describe('bookmarks', () => {
  test.todo('bookmark and remove bookmark are idempotent');
  test.todo('list bookmarks only for the owner, paginated');
});

describe('deletes', () => {
  test.todo('deleting a post removes its likes, reposts and bookmarks');
  test.todo('deleting a user removes their engagement');
});
