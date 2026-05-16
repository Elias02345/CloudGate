import {
	Alert,
	Anchor,
	Badge,
	Button,
	Card,
	Group,
	Image,
	Modal,
	PasswordInput,
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMantineColorScheme } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconDownload, IconShieldCheck } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useMe } from '../api/auth.js';
import { api, getStoredToken } from '../api/client.js';
import { useTotpDisable, useTotpEnable, useTotpSetup } from '../api/totp.js';

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

			<ProfileCard />

			<TwoFactorCard />

			<AppearanceCard
				language={i18n.resolvedLanguage}
				onLanguage={onLanguageChange}
				colorScheme={colorScheme}
				onScheme={(v) => setColorScheme(v as 'light' | 'dark' | 'auto')}
			/>

			<BackupCard />

			<AboutCard version={health.data?.version} uptime={health.data?.uptime_seconds} />
		</Stack>
	);

	function ProfileCard() {
		return (
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
				</Stack>
			</Card>
		);
	}
}

// ===========================================================================
// 2FA Card
// ===========================================================================

function TwoFactorCard() {
	const { t } = useTranslation();
	const { data: me } = useMe();
	const [setupOpened, setupModal] = useDisclosure(false);
	const [disableOpened, disableModal] = useDisclosure(false);
	const setup = useTotpSetup();
	const enable = useTotpEnable();
	const disable = useTotpDisable();
	const [code, setCode] = useState('');
	const [disablePw, setDisablePw] = useState('');

	const isEnabled = !!me?.user?.totp_enabled;

	const onStartSetup = async () => {
		try {
			await setup.mutateAsync();
			setupModal.open();
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const onConfirm = async () => {
		if (!setup.data) return;
		try {
			await enable.mutateAsync({ secret: setup.data.secret, code });
			setupModal.close();
			setCode('');
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('settings.totp_enabled_title'),
				message: t('settings.totp_enabled_message'),
			});
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const onDisable = async () => {
		try {
			await disable.mutateAsync(disablePw);
			disableModal.close();
			setDisablePw('');
			notifications.show({ color: 'green', message: t('settings.totp_disabled_message') });
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	return (
		<Card withBorder>
			<Stack>
				<Group justify="space-between">
					<Group>
						<IconShieldCheck size={20} color={isEnabled ? '#51cf66' : '#868e96'} />
						<Title order={4}>{t('settings.totp_title')}</Title>
					</Group>
					<Badge color={isEnabled ? 'green' : 'gray'} variant="light">
						{isEnabled ? t('settings.totp_enabled') : t('settings.totp_disabled')}
					</Badge>
				</Group>
				<Text size="sm" c="dimmed">
					{t('settings.totp_hint')}
				</Text>
				{!isEnabled ? (
					<Button variant="light" onClick={onStartSetup} loading={setup.isPending}>
						{t('settings.totp_setup_button')}
					</Button>
				) : (
					<Button variant="light" color="red" onClick={disableModal.open}>
						{t('settings.totp_disable_button')}
					</Button>
				)}
			</Stack>

			<Modal opened={setupOpened} onClose={setupModal.close} title={t('settings.totp_setup_title')} size="md">
				{setup.data && (
					<Stack>
						<Text size="sm">{t('settings.totp_scan_qr')}</Text>
						<Image src={setup.data.qr_code_data_url} alt="QR" w={200} h={200} mx="auto" />
						<Text size="xs" c="dimmed" ta="center" ff="monospace">
							{setup.data.secret}
						</Text>
						<TextInput
							label={t('settings.totp_code_field')}
							placeholder="123456"
							value={code}
							onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
							inputMode="numeric"
							required
						/>
						<Button onClick={onConfirm} loading={enable.isPending} disabled={code.length !== 6}>
							{t('settings.totp_confirm')}
						</Button>
					</Stack>
				)}
			</Modal>

			<Modal opened={disableOpened} onClose={disableModal.close} title={t('settings.totp_disable_title')}>
				<Stack>
					<Alert color="orange">{t('settings.totp_disable_warning')}</Alert>
					<PasswordInput
						label={t('password.current')}
						value={disablePw}
						onChange={(e) => setDisablePw(e.currentTarget.value)}
						required
					/>
					<Button color="red" onClick={onDisable} loading={disable.isPending} disabled={!disablePw}>
						{t('settings.totp_disable_confirm')}
					</Button>
				</Stack>
			</Modal>
		</Card>
	);
}

// ===========================================================================
// Appearance Card
// ===========================================================================

function AppearanceCard(props: {
	language: string | undefined;
	onLanguage: (v: string | null) => void;
	colorScheme: string;
	onScheme: (v: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<Card withBorder>
			<Stack>
				<Title order={4}>{t('settings.appearance_title')}</Title>
				<Group justify="space-between">
					<Text>{t('settings.language')}</Text>
					<Select
						value={props.language}
						onChange={props.onLanguage}
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
						value={props.colorScheme}
						onChange={props.onScheme}
						data={[
							{ value: 'light', label: t('settings.theme_light') },
							{ value: 'dark', label: t('settings.theme_dark') },
							{ value: 'auto', label: t('settings.theme_auto') },
						]}
					/>
				</Group>
			</Stack>
		</Card>
	);
}

// ===========================================================================
// Backup Card
// ===========================================================================

function BackupCard() {
	const { t } = useTranslation();
	const [opened, modal] = useDisclosure(false);
	const [pass, setPass] = useState('');
	const [confirm, setConfirm] = useState('');
	const [busy, setBusy] = useState(false);

	const onDownload = async () => {
		if (pass.length < 8 || pass !== confirm) return;
		setBusy(true);
		try {
			const token = getStoredToken();
			const url = `/api/backup?passphrase=${encodeURIComponent(pass)}`;
			// Trigger download via fetch + blob
			const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'cloudgate-backup.cgbk';
			a.download = name;
			a.click();
			URL.revokeObjectURL(a.href);
			modal.close();
			setPass('');
			setConfirm('');
			notifications.show({ color: 'green', message: t('settings.backup_done') });
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card withBorder>
			<Stack>
				<Group justify="space-between">
					<Title order={4}>{t('settings.backup_title')}</Title>
					<Button leftSection={<IconDownload size={16} />} variant="light" onClick={modal.open}>
						{t('settings.backup_button')}
					</Button>
				</Group>
				<Text size="sm" c="dimmed">
					{t('settings.backup_hint')}
				</Text>
			</Stack>
			<Modal opened={opened} onClose={modal.close} title={t('settings.backup_modal_title')}>
				<Stack>
					<Alert color="blue">{t('settings.backup_modal_hint')}</Alert>
					<PasswordInput
						label={t('settings.backup_passphrase')}
						value={pass}
						onChange={(e) => setPass(e.currentTarget.value)}
						minLength={8}
						required
					/>
					<PasswordInput
						label={t('settings.backup_passphrase_confirm')}
						value={confirm}
						onChange={(e) => setConfirm(e.currentTarget.value)}
						error={confirm && confirm !== pass ? t('password.mismatch') : null}
						required
					/>
					<Button onClick={onDownload} disabled={pass.length < 8 || pass !== confirm} loading={busy}>
						{t('settings.backup_download')}
					</Button>
				</Stack>
			</Modal>
		</Card>
	);
}

// ===========================================================================
// About Card
// ===========================================================================

function AboutCard(props: { version?: string; uptime?: number }) {
	const { t } = useTranslation();
	return (
		<Card withBorder>
			<Stack>
				<Title order={4}>{t('settings.about_title')}</Title>
				<Group justify="space-between">
					<Text size="sm" c="dimmed">
						{t('settings.version')}
					</Text>
					<Text ff="monospace">{props.version ?? '…'}</Text>
				</Group>
				<Group justify="space-between">
					<Text size="sm" c="dimmed">
						{t('settings.uptime')}
					</Text>
					<Text ff="monospace">{props.uptime !== undefined ? `${Math.floor(props.uptime / 60)} min` : '…'}</Text>
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
	);
}
