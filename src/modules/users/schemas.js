// Zod validation schemas for the users module.
import { z } from 'zod';

// Field rules shared with other modules (auth's register). Each matches a users table constraint.
export const usernameSchema = z.string().regex(/^[A-Za-z0-9_]{3,15}$/, 'Invalid username'); // users_username_format
export const displayNameSchema = z.string().trim().min(1).max(50); // users_display_name_length

export const usernameParamSchema = z.object({
  username: usernameSchema,
});

// PATCH /users/me. Partial: send only the fields to change; bio: null clears it.
// Limits match users_display_name_length / users_bio_length. Unknown keys (e.g. email, username) are rejected.
export const updateProfileSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    bio: z.string().max(160).nullable().optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, { message: 'Nothing to update' });
