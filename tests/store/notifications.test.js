// Notifications store (milestone 5). Turn todos into tests as the store is built.

describe('create', () => {
  test.todo('creates a notification for the recipient with actor, type and target');
  test.todo('no notification for actions on your own content (if that is the design)');
  test.todo('repeated actions do not create duplicate notifications (e.g. like, unlike, like again)');
});

describe('list', () => {
  test.todo("only the recipient's notifications, newest first, paginated");
  test.todo('includes actor info');
});

describe('read state', () => {
  test.todo('mark one as read; mark all as read');
  test.todo('unread count');
  test.todo("cannot mark another user's notification (store filters by recipient)");
});

describe('deletes', () => {
  test.todo('deleting the actor, recipient or target cleans up notifications as designed');
});
