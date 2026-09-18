import { Skeleton, Stack } from '@mantine/core';

/**
 * Placeholder rows for a list or table that is still loading.
 *
 * Replaces the bare "Lädt…" line these pages used to show. That line was a
 * single short string where a table was about to appear, so the content
 * jumped into place from nothing and the wait read as "empty" rather than
 * "loading" — the two states looked almost the same, which is the one thing a
 * loading state has to get right.
 *
 * Mantine's Skeleton animates on its own, and respects reduced-motion through
 * the same global rule as the rest of the app.
 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
	return (
		<Stack gap="sm" aria-busy="true" aria-live="polite">
			{Array.from({ length: rows }, (_, i) => (
				// Fixed-length placeholder list: index is the only identity these
				// have, and they never reorder.
				// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
				<Skeleton key={i} height={38} radius="md" />
			))}
		</Stack>
	);
}
