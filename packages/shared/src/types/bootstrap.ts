import { z } from 'zod';

export const BootstrapStepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type BootstrapStepStatus = z.infer<typeof BootstrapStepStatusSchema>;

export const BootstrapStepSchema = z.object({
	name: z.string(),
	status: BootstrapStepStatusSchema,
	error: z.string().nullable(),
	started_at: z.string().datetime().nullable(),
	finished_at: z.string().datetime().nullable(),
});
export type BootstrapStep = z.infer<typeof BootstrapStepSchema>;

export const BootstrapStatusSchema = z.object({
	complete: z.boolean(),
	steps: z.array(BootstrapStepSchema),
	last_error: z.string().nullable(),
	version: z.string(),
});
export type BootstrapStatus = z.infer<typeof BootstrapStatusSchema>;

/**
 * The list of bootstrap steps that always run, in order.
 * Each must be idempotent — see CLAUDE.md §2.
 */
export const BOOTSTRAP_STEPS = [
	'disk-health',
	'ensure-data-dirs',
	'ensure-secrets',
	'ensure-playit-binary',
	'init-db',
	'run-migrations',
	'seed-admin-if-missing',
	'init-gpg-keyring',
	'cleanup-stale-files',
	'write-marker',
] as const;
export type BootstrapStepName = (typeof BOOTSTRAP_STEPS)[number];
