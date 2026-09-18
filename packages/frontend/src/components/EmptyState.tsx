import { Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * What a list shows when it has nothing in it yet.
 *
 * These pages used to render one dimmed sentence, which on a fresh install is
 * the very first thing a new user sees on most screens — and it looked more
 * like something had failed to load than like an invitation. A muted icon and
 * room for the page's own primary action make the difference between "broken"
 * and "nothing here yet".
 *
 * The icon fades and rises in once. Deliberately once, and deliberately small:
 * an empty list is not an achievement to celebrate, and anything looping here
 * would pull the eye away from the action next to it. Reduced-motion is
 * handled by the global rule in styles/global.css.
 */
export function EmptyState({
	icon,
	title,
	hint,
	action,
}: {
	icon?: ReactNode;
	title: string;
	hint?: string;
	/** The page's primary next step, when there is an obvious one. */
	action?: ReactNode;
}) {
	return (
		<Stack align="center" gap="xs" py="xl" className="cg-empty-state">
			{icon && <div className="cg-empty-state__icon">{icon}</div>}
			<Text c="dimmed" ta="center" fw={500}>
				{title}
			</Text>
			{hint && (
				<Text c="dimmed" ta="center" size="sm" maw={420}>
					{hint}
				</Text>
			)}
			{action}
		</Stack>
	);
}
