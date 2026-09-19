import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.js';

/**
 * What a list shows when it could not be loaded.
 *
 * None of these pages checked `isError`, which left two bad outcomes. On a
 * first load with the backend down, every render branch missed — `isLoading`
 * was false, `data` undefined — so the card simply appeared empty, as if
 * nothing were configured. On a background refetch that failed, the query
 * kept the last successful data and the page went on presenting it as
 * current, silently, while nothing could refresh.
 *
 * Saying so is the whole point: an empty list and an unreachable backend must
 * not look the same.
 */
export function ListError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
	const { t } = useTranslation();

	// The backend's own message is more useful than anything generic — it
	// names the subsystem that failed. A network-level failure has none.
	const detail =
		error instanceof ApiError
			? `${error.message}${error.code ? ` (${error.code})` : ''}`
			: error instanceof Error
				? error.message
				: null;

	return (
		<Alert color="red" icon={<IconAlertTriangle size={18} />} title={t('common.load_failed')}>
			<Stack gap="sm">
				<Text size="sm">{t('common.load_failed_hint')}</Text>
				{detail && (
					<Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-word' }}>
						{detail}
					</Text>
				)}
				{onRetry && (
					<Group>
						<Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
							{t('common.retry')}
						</Button>
					</Group>
				)}
			</Stack>
		</Alert>
	);
}
