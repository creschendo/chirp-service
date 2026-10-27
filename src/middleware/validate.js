// Validation middleware: runs a route's Zod schemas before its handler, so handlers don't repeat the
// safeParse / 400 boilerplate.
//
//   router.patch('/:post_id', requireAuth, validate({ params: postIdParamSchema, body: updatePostSchema }), handler)
//
// The 400 message is the failing schema's description, set where the schema is defined:
//   z.object({ username: ... }).describe('Invalid username')
// Schemas without one get the default for their part (below).
//
// Parts are checked in order (params, query, body); the first that fails gets a 400 and the handler never runs.
// Parsed results (trimmed, coerced, defaulted, cursors decoded) go on req.valid, e.g. req.valid.query.limit.
// They aren't written back onto req.query because Express 5 makes req.query read-only; one place for all three
// keeps handlers consistent. Put requireAuth before validate, so a request that isn't logged in gets 401, not 400.

// Default 400 messages, for schemas without a .describe().
const MESSAGES = {
  params: 'Invalid parameters',
  query: 'Invalid query',
  body: 'Invalid input',
};

// schemas: { params?, query?, body? }, each a Zod schema.
export function validate(schemas) {
  return (req, res, next) => {
    req.valid = {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;

      const parsed = schema.safeParse(req[part]);
      if (!parsed.success) {
        return res.status(400).json({ error: schema.description ?? MESSAGES[part], issues: parsed.error.issues });
      }
      req.valid[part] = parsed.data;
    }
    next();
  };
}
