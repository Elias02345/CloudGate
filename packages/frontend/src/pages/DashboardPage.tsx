import { Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconCloudCheck, IconRoute } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

interface HealthResponse {
	status: string;
	version: string;
	db: boolean;
	uptime_seconds: number;
}

export function DashboardPage() {
	const { t } = useTranslation();
	const { data, isLoading, isError } = useQuery<HealthResponse>({
		queryKey: ['health'],
		queryFn: async () => {
			const res = await fetch('/api/health');
			if (!res.ok) throw new Error('Health check failed');
			return res.json();
		},
		refetchInterval: 10_000,
	});

	return (
		<Stack>
			<Title order={2}>{t('dashboard.title')}</Title>
			<Group grow align="stretch">
				<Card shadow="sm" radius="md" withBorder>
					<Group>
						<IconCloudCheck size={28} color="#51cf66" />
						<Stack gap={0}>
							<Text size="sm" c="dimmed">
								{t('dashboard.backend_status')}
							</Text>
							<Text fw={600}>
								{isLoading
									? t('common.loading')
									: isError
										? t('dashboard.unreachable')
										: data?.status === 'ok'
											? t('dashboard.healthy')
											: t('dashboard.degraded')}
							</Text>
						</Stack>
					</Group>
				</Card>
				<Card shadow="sm" radius="md" withBorder>
					<Group>
						<IconRoute size={28} color="#ff9966" />
						<Stack gap={0}>
							<Text size="sm" c="dimmed">
								{t('dashboard.version')}
							</Text>
							<Text fw={600}>{data?.version ?? '—'}</Text>
						</Stack>
					</Group>
				</Card>
			</Group>
			<Text c="dimmed" size="sm">
				{t('dashboard.placeholder_hint')}
			</Text>
		</Stack>
	);
}
