import {
	Anchor,
	Badge,
	Card,
	Group,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Title,
} from '@mantine/core';
import { useMantineColorScheme } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useMe } from '../api/auth.js';

interface HealthResponse {
	status: string;
	version: string;
	uptime_seconds: number;
}

export function SettingsPage() {
	const { t, i18n } = useTranslation();
	const { colorScheme, setColorScheme } = useMantineColorScheme();
	const { data: me } = useMe();
	const health = useQuery<HealthResponse>({
		queryKey: ['health'],
		queryFn: () => api('/health'),
	});

	const onLanguageChange = (value: string | null) => {
		if (value) void i18n.changeLanguage(value);
	};

	return (
		<Stack>
			<Title order={2}>{t('settings.title')}</Title>

			{/* Profile */}
			<Card withBorder>
				<Stack>
					<Title order={4}>{t('settings.profile_title')}</Title>
					{me?.user && (
						<Group justify="space-between">
							<Stack gap={0}>
								<Text fw={500}>{me.user.name}</Text>
								<Text size="sm" c="dimmed">
									{me.user.email}
								</Text>
							</Stack>
							{me.user.is_admin && <Badge>{t('settings.role_admin')}</Badge>}
						</Group>
					)}
					<Group>
						<Text size="sm">{t('settings.totp_status')}:</Text>
						<Badge color={me?.user?.totp_enabled ? 'green' : 'gray'} variant="light">
							{me?.user?.totp_enabled ? t('settings.totp_enabled') : t('settings.totp_disabled')}
						</Badge>
						<Text size="xs" c="dimmed">
							({t('settings.totp_coming')})
						</Text>
					</Group>
				</Stack>
			</Card>

			{/* Appearance */}
			<Card withBorder>
				<Stack>
					<Title order={4}>{t('settings.appearance_title')}</Title>
					<Group justify="space-between">
						<Text>{t('settings.language')}</Text>
						<Select
							value={i18n.resolvedLanguage}
							onChange={onLanguageChange}
							data={[
								{ value: 'en', label: 'English' },
								{ value: 'de', label: 'Deutsch' },
							]}
							w={180}
						/>
					</Group>
					<Group justify="space-between">
						<Text>{t('settings.theme')}</Text>
						<SegmentedControl
							value={colorScheme}
							onChange={(v) => setColorScheme(v as 'light' | 'dark' | 'auto')}
							data={[
								{ value: 'light', label: t('settings.theme_light') },
								{ value: 'dark', label: t('settings.theme_dark') },
								{ value: 'auto', label: t('settings.theme_auto') },
							]}
						/>
					</Group>
				</Stack>
			</Card>

			{/* About */}
			<Card withBorder>
				<Stack>
					<Title order={4}>{t('settings.about_title')}</Title>
					<Group justify="space-between">
						<Text size="sm" c="dimmed">
							{t('settings.version')}
						</Text>
						<Text ff="monospace">{health.data?.version ?? '…'}</Text>
					</Group>
					<Group justify="space-between">
						<Text size="sm" c="dimmed">
							{t('settings.uptime')}
						</Text>
						<Text ff="monospace">
							{health.data ? `${Math.floor(health.data.uptime_seconds / 60)} min` : '…'}
						</Text>
					</Group>
					<Group justify="space-between">
						<Text size="sm" c="dimmed">
							{t('settings.source')}
						</Text>
						<Anchor href="https://github.com/Elias02345/CloudGate" target="_blank" size="sm">
							github.com/Elias02345/CloudGate
						</Anchor>
					</Group>
				</Stack>
			</Card>

			{/* Coming soon — backup, audit, updates */}
			<Card withBorder style={{ opacity: 0.7 }}>
				<Stack>
					<Title order={4}>{t('settings.coming_title')}</Title>
					<Text size="sm" c="dimmed">
						{t('settings.coming_backup')}
					</Text>
					<Text size="sm" c="dimmed">
						{t('settings.coming_audit')}
					</Text>
					<Text size="sm" c="dimmed">
						{t('settings.coming_updates')}
					</Text>
				</Stack>
			</Card>
		</Stack>
	);
}
