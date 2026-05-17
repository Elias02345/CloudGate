import { Badge, Tooltip } from '@mantine/core';
import { IconArrowUp } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useUpdateStatus } from '../api/updates.js';

/**
 * Pulsing badge in the header when an update is available.
 * Click → navigate to /updates.
 */
export function UpdateBanner() {
	const { t } = useTranslation();
	const { data } = useUpdateStatus();
	const navigate = useNavigate();

	if (!data?.update_available || !data.latest_version) return null;

	return (
		<Tooltip label={t('updates.banner_tooltip', { version: data.latest_version })}>
			<Badge
				leftSection={<IconArrowUp size={14} />}
				color="cg-orange"
				variant="filled"
				style={{ cursor: 'pointer' }}
				onClick={() => navigate('/updates')}
				size="lg"
			>
				{t('updates.banner_label', { version: data.latest_version })}
			</Badge>
		</Tooltip>
	);
}
