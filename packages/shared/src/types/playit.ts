import { z } from 'zod';

/**
 * Public representation of a linked Playit.gg account.
 * The secret_key never crosses the network — only stored encrypted server-side.
 */
export const PlayitAccountSchema = z.object({
	id: z.number().int().positive(),
	label: z.string(),
	status: z.enum(['active', 'disabled', 'error']),
	last_validated_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
});
export type PlayitAccount = z.infer<typeof PlayitAccountSchema>;

export const CreatePlayitAccountRequestSchema = z.object({
	label: z.string().min(1).max(80),
	/**
	 * Playit "agent secret" — obtained from playit.gg/account/agents
	 * (or the agent setup flow). Long opaque string. We don't validate the
	 * shape beyond a minimum length so future Playit format changes don't
	 * break the form.
	 */
	secret_key: z.string().min(20).max(2000),
});
export type CreatePlayitAccountRequest = z.infer<typeof CreatePlayitAccountRequestSchema>;

/**
 * Snapshot of how many TCP / UDP tunnels the linked account currently uses,
 * shown to the user as a quota bar. Playit's free tier is 4 TCP + 4 UDP.
 */
export const PlayitQuotaSchema = z.object({
	tcp_used: z.number().int().nonnegative(),
	udp_used: z.number().int().nonnegative(),
	tcp_limit: z.number().int().positive(),
	udp_limit: z.number().int().positive(),
});
export type PlayitQuota = z.infer<typeof PlayitQuotaSchema>;
