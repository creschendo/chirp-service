// Zod validation schemas for the users module.
import { z } from 'zod';

// Same rule as the users_username_format check constraint.
export const usernameParamSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,15}$/, 'Invalid username'),
});

// PATCH /users/me. Partial: send only the fields to change; bio: null clears it.
// Limits match users_display_name_length / users_bio_length. Unknown keys (e.g. email, username) are rejected.
export const updateProfileSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(50).optional(),
    bio: z.string().max(160).nullable().optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, { message: 'Nothing to update' });
