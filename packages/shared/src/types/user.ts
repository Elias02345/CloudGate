import { z } from 'zod';

export const UserSchema = z.object({
	id: z.number().int().positive(),
	email: z.string().email(),
	name: z.string().min(1).max(100),
	is_admin: z.boolean(),
	totp_enabled: z.boolean(),
	must_change_password: z.boolean(),
	last_login_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const LoginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
	totp_code: z
		.string()
		.regex(/^\d{6}$/)
		.optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
	access_token: z.string(),
	user: UserSchema,
	must_change_password: z.boolean(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const ChangePasswordRequestSchema = z.object({
	current_password: z.string().min(1),
	new_password: z.string().min(12).max(200),
	/** Optional — only honoured when the user is still on a default admin profile
	 *  (must_change_password=true) and lets them set their own email/name during
	 *  the first-login flow. Ignored on subsequent password changes. */
	email: z.string().email().optional(),
	name: z.string().min(1).max(100).optional(),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
