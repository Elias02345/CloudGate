import { z } from 'zod';

export const UpdateChannelSchema = z.enum(['stable', 'prerelease', 'nightly', 'disabled']);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export const UpdateModeSchema = z.enum(['auto', 'notify', 'scheduled']);
export type UpdateMode = z.infer<typeof UpdateModeSchema>;

export const UpdateStateSchema = z.enum([
	'idle',
	'checking',
	'available',
	'downloading',
	'verifying',
	'installing',
	'rolling_back',
	'failed',
]);
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UpdateStatusSchema = z.object({
	current_version: z.string(),
	latest_version: z.string().nullable(),
	update_available: z.boolean(),
	state: UpdateStateSchema,
	last_checked_at: z.string().datetime().nullable(),
	channel: UpdateChannelSchema,
	mode: UpdateModeSchema,
	last_error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const UpdateManifestSchema = z.object({
	version: z.string(),
	min_upgrade_from: z.string().optional(),
	required_migrations: z.array(z.string()),
	persisted_paths_check: z.array(z.string()),
	breaking_changes: z.boolean().default(false),
	post_install_actions: z
		.array(
			z.object({
				type: z.enum(['regenerate', 'restart-service']),
				target: z.string(),
			})
		)
		.default([]),
});
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;

export const UpdateHistoryEntrySchema = z.object({
	id: z.number().int().positive(),
	from_version: z.string(),
	to_version: z.string(),
	outcome: z.enum(['succeeded', 'failed', 'rolled_back']),
	steps_completed: z.array(z.string()),
	error_message: z.string().nullable(),
	started_at: z.string().datetime(),
	finished_at: z.string().datetime().nullable(),
});
export type UpdateHistoryEntry = z.infer<typeof UpdateHistoryEntrySchema>;
