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

/**
 * Fine-grained install step. Free-form so future versions can add steps
 * without breaking older frontends — they'll just show the raw step id.
 */
export const UpdateStepSchema = z.enum([
	'acquire_lock',
	'download_archive',
	'download_sha',
	'download_sig',
	'verify_sha',
	'verify_gpg',
	'spawn_apply',
	'apply_running',
	'done',
	'failed',
]);
export type UpdateStep = z.infer<typeof UpdateStepSchema>;

export const UpdateStatusSchema = z.object({
	current_version: z.string(),
	latest_version: z.string().nullable(),
	update_available: z.boolean(),
	state: UpdateStateSchema,
	last_checked_at: z.string().datetime().nullable(),
	channel: UpdateChannelSchema,
	mode: UpdateModeSchema,
	last_error: z.string().nullable(),
	release_notes_url: z.string().nullable().optional(),

	// Fine-grained install progress (only meaningful when state is in
	// downloading/verifying/installing). All optional so older clients
	// stay compatible.
	step: UpdateStepSchema.nullable().optional(),
	step_label: z.string().nullable().optional(),
	/** 0..100 — backend's own contribution; the SPA interpolates the apply phase from the wall clock. */
	overall_progress: z.number().min(0).max(100).nullable().optional(),
	download_bytes: z.number().int().nonnegative().nullable().optional(),
	download_total: z.number().int().nonnegative().nullable().optional(),
	started_at: z.string().datetime().nullable().optional(),
	target_version: z.string().nullable().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/** Tail of /data/logs/update-history.log + cursor for incremental fetch. */
export interface UpdateLogResponse {
	lines: string[];
	byte_offset: number;
}

/** Last-update marker (parsed from /data/updates/.last-update-*.json). */
export interface LastUpdateMarker {
	from: string;
	to: string;
	outcome: 'succeeded' | 'failed' | 'rolled_back';
	reason: string;
	started_at: string;
}

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
