// Cursor pagination shared by list endpoints.
// Responses are { items, nextCursor }; nextCursor is an opaque string the client sends back as ?cursor=
// to get the next page, or null on the last page. Inside it is JSON (e.g. the last row's sort keys),
// base64url-encoded so its contents can change without breaking clients.
import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Returns the decoded value, or null if the string isn't a cursor we produced.
export function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Query schema for ?limit=&cursor=. cursorSchema validates the decoded cursor contents for this endpoint.
// Parsed result: { limit: number, cursor: object | null }.
export function pageQuerySchema(cursorSchema) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    cursor: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return null;
        const parsed = cursorSchema.safeParse(decodeCursor(value));
        if (!parsed.success) {
          ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
          return z.NEVER;
        }
        return parsed.data;
      }),
  });
}

// Builds a page from rows fetched with limit + 1: the extra row only signals that another page exists.
// toCursor maps the last returned row to the values the next query continues after.
export function toPage(rows, limit, toCursor) {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(toCursor(items.at(-1))) : null;
  return { items, nextCursor };
}
