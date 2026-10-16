// Zod validation schemas for the users module.
import { z } from 'zod';

// Same rule as the users_username_format check constraint.
export const usernameParamSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,15}$/, 'Invalid username'),
});
