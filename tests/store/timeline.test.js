// Timeline store (milestone 3; reposts and counts in milestone 4). The most query-heavy store: ordering and
// pagination edge cases matter most here.

describe('home timeline', () => {
  test.todo('contains posts from followed users and the viewer, not from others');
  test.todo('newest first');
  test.todo("unfollowing removes that user's posts");
  test.todo('includes reposts by followed users, ordered by repost time');
  test.todo('a post reposted by several followed users appears once (or as designed)');
});

describe('profile timeline', () => {
  test.todo("only that user's posts (and reposts, if included), newest first");
  test.todo('excludes replies (if that is the design)');
});

describe('pagination', () => {
  test.todo('cursor returns the next page without skipping or repeating posts');
  test.todo('posts with identical created_at are split across pages correctly');
  test.todo('a post created between page requests does not shift later pages');
  test.todo('last page returns fewer than limit; empty timeline -> []');
});

describe('item shape', () => {
  test.todo('each item has author info, engagement counts and viewer flags');
  test.todo('never includes email or password hash');
});
