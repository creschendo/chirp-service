// Zod validation schemas for the auth module.
import { z } from 'zod';
import { usernameSchema, displayNameSchema } from '../users/schemas.js';

// bcrypt only uses the first 72 bytes of a password; anything after that is silently ignored,
// so longer passwords are rejected rather than half-checked.
const BCRYPT_MAX_BYTES = 72;

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES, {
    message: `Password must be at most ${BCRYPT_MAX_BYTES} bytes`,
  });

// POST /auth/register. displayName is optional; the service defaults it to the username.
// Unknown keys are rejected. Email case is kept as typed; uniqueness ignores case (citext).
export const registerSchema = z.strictObject({
  username: usernameSchema,
  email: z.string().trim().pipe(z.email('Invalid email').max(254)),
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});

// POST /auth/login. `login` is a username or an email; the store matches either, ignoring case.
// Only shape is checked here: format rules would reveal what a valid username or email looks like,
// and a wrong value simply fails the credential check.
export const loginSchema = z.object({
  login: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});
