import { Alert, Anchor, Badge, Card, Grid, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import {
	IconAlertTriangle,
	IconCheck,
	IconCloudCheck,
	IconRoute,
	IconServer2,
	IconWorld,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useCloudflareAccounts } from '../api/cloudflare.js';
import { useHosts } from '../api/hosts.js';
import { useTunnels } from '../api/tunnels.js';
import { api } from '../api/client.js';
import { wasOnboardingDismissed } from './OnboardingPage.js';

interface HealthResponse {
	status: string;
	version: string;
	db: boolean;
	uptime_seconds: number;
}

function StatCard({
	icon,
	label,
	value,
	loading,
	color,
	to,
}: {
	icon: React.ReactNode;
	label: string;
	value: string | number;
	loading?: boolean;
	color?: string;
	to?: string;
}) {
	const content = (
		<Card shadow="sm" radius="md" withBorder style={{ height: '100%' }}>
			<Group>
				<div style={{ color: color ?? '#ff9966' }}>{icon}</div>
				<Stack gap={0}>
					<Text size="sm" c="dimmed">
						{label}
					</Text>
					{loading ? <Skeleton h={22} w={50} mt={4} /> : <Text fw={700} size="lg">{value}</Text>}
				</Stack>
			</Group>
		</Card>
	);
	return to ? (
		<Anchor component={Link} to={to} underline="never" c="inherit" style={{ height: '100%' }}>
			{content}
		</Anchor>
	) : (
		content
	);
}

export function DashboardPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const health = useQuery<HealthResponse>({
		queryKey: ['health'],
		queryFn: () => api('/health'),
		refetchInterval: 10_000,
	});
	const accounts = useCloudflareAccounts();
	const tunnels = useTunnels();
	const hosts = useHosts();

	const accountsCount = accounts.data?.accounts.length ?? 0;
	const tunnelsCount = tunnels.data?.tunnels.length ?? 0;

	// Auto-redirect new users to onboarding (unless dismissed)
	const allEmpty =
		!accounts.isLoading &&
		!tunnels.isLoading &&
		!hosts.isLoading &&
		accountsCount === 0 &&
		tunnelsCount === 0 &&
		(hosts.data?.hosts.length ?? 0) === 0;
	useEffect(() => {
		if (allEmpty && !wasOnboardingDismissed()) {
			navigate('/onboarding', { replace: true });
		}
	}, [allEmpty, navigate]);

	const tunnelsRunning = tunnels.data?.tunnels.filter((t) => t.live_status === 'running').length ?? 0;
	const hostsCount = hosts.data?.hosts.length ?? 0;
	const hostsLive = hosts.data?.hosts.filter((h) => h.enabled && h.last_deployed_at && !h.last_error).length ?? 0;
	const hostsError = hosts.data?.hosts.filter((h) => h.last_error).length ?? 0;

	const backendHealthy = health.data?.status === 'ok';

	return (
		<Stack>
			<Group justify="space-between" align="center">
				<Title order={2}>{t('dashboard.title')}</Title>
				<Badge color={backendHealthy ? 'green' : 'red'} variant="light" leftSection={<IconCheck size={14} />}>
					{backendHealthy ? t('dashboard.healthy') : t('dashboard.degraded')}
				</Badge>
			</Group>

			{hostsError > 0 && (
				<Alert color="red" icon={<IconAlertTriangle size={18} />} title={t('dashboard.hosts_errors_title')}>
					{t('dashboard.hosts_errors_message', { count: hostsError })}
				</Alert>
			)}

			<Grid>
				<Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
					<StatCard
						icon={<IconCloudCheck size={28} />}
						label={t('dashboard.card_accounts')}
						value={accountsCount}
						loading={accounts.isLoading}
						to="/cloudflare"
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
					<StatCard
						icon={<IconRoute size={28} />}
						label={t('dashboard.card_tunnels')}
						value={`${tunnelsRunning} / ${tunnelsCount}`}
						loading={tunnels.isLoading}
						to="/tunnels"
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
					<StatCard
						icon={<IconServer2 size={28} />}
						label={t('dashboard.card_hosts')}
						value={`${hostsLive} / ${hostsCount}`}
						loading={hosts.isLoading}
						to="/hosts"
						color={hostsError > 0 ? '#fa5252' : '#51cf66'}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
					<StatCard
						icon={<IconWorld size={28} />}
						label={t('dashboard.card_version')}
						value={health.data?.version ?? '—'}
						loading={health.isLoading}
					/>
				</Grid.Col>
			</Grid>

			{accountsCount === 0 && (
				<Alert color="blue" title={t('dashboard.first_steps_title')}>
					<Stack gap="xs">
						<Text size="sm">{t('dashboard.first_steps_intro')}</Text>
						<Text size="sm">
							1. <Anchor component={Link} to="/cloudflare">
								{t('dashboard.first_steps_1')}
							</Anchor>
						</Text>
						<Text size="sm">
							2. <Anchor component={Link} to="/tunnels">
								{t('dashboard.first_steps_2')}
							</Anchor>
						</Text>
						<Text size="sm">
							3. <Anchor component={Link} to="/hosts">
								{t('dashboard.first_steps_3')}
							</Anchor>
						</Text>
					</Stack>
				</Alert>
			)}

			{accountsCount > 0 && hostsCount === 0 && (
				<Alert color="cyan" title={t('dashboard.next_step_title')}>
					{t('dashboard.next_step_message')}{' '}
					<Anchor component={Link} to="/hosts/new">
						{t('dashboard.next_step_link')}
					</Anchor>
				</Alert>
			)}
		</Stack>
	);
}
