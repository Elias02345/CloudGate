import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Card,
	Code,
	Group,
	Select,
	Stack,
	Text,
	Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconArrowUp, IconCircleCheck, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	type UpdateStatus,
	useCheckUpdates,
	useInstallUpdate,
	useUpdateSettings,
	useUpdateStatus,
} from '../api/updates.js';
import { UpdateProgressModal, shouldShowModalForStatus } from '../components/UpdateProgressModal.js';

function stateColor(s: UpdateStatus['state']): string {
	switch (s) {
		case 'idle':
			return 'gray';
		case 'available':
			return 'cyan';
		case 'checking':
		case 'downloading':
		case 'verifying':
		case 'installing':
			return 'yellow';
		case 'rolling_back':
		case 'failed':
			return 'red';
		default:
			return 'gray';
	}
}

export function UpdatesPage() {
	const { t } = useTranslation();
	// Poll every 2s while the modal is open so the install progress stays fresh
	const [modalOpen, setModalOpen] = useState(false);
	const [modalTarget, setModalTarget] = useState<string | null>(null);
	const [modalStarting, setModalStarting] = useState<string | null>(null);
	const { data, isLoading } = useUpdateStatus({ refetchInterval: modalOpen ? 2_000 : 30_000 });
	const check = useCheckUpdates();
	const install = useInstallUpdate();
	const settings = useUpdateSettings();

	// Auto-open modal if the backend reports an install is already in flight
	// (e.g. user navigated to /updates mid-update from elsewhere).
	if (!modalOpen && shouldShowModalForStatus(data) && data?.target_version && data?.current_version) {
		setModalTarget(data.target_version);
		setModalStarting(data.current_version);
		setModalOpen(true);
	}

	const onCheck = async () => {
		try {
			await check.mutateAsync();
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const onInstall = async () => {
		if (!data?.latest_version) return;
		if (!confirm(t('updates.confirm_install', { version: data.latest_version }))) return;
		// Open the progress modal *before* the install RPC returns — the RPC
		// resolves quickly (it spawns a detached child) and we want the SSE
		// subscription up before backend events start firing.
		setModalTarget(data.latest_version);
		setModalStarting(data.current_version);
		setModalOpen(true);
		try {
			await install.mutateAsync(data.latest_version);
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const onSettingsChange = async (channel: UpdateStatus['channel'], mode: UpdateStatus['mode']) => {
		try {
			await settings.mutateAsync({ channel, mode });
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	if (isLoading || !data) {
		return <Text c="dimmed">{t('common.loading')}</Text>;
	}

	return (
		<Stack>
			<Title order={2}>{t('updates.title')}</Title>

			{modalTarget && modalStarting && (
				<UpdateProgressModal
					opened={modalOpen}
					onClose={() => setModalOpen(false)}
					targetVersion={modalTarget}
					startingVersion={modalStarting}
				/>
			)}

			<Card withBorder data-tour="updates-status">
				<Stack>
					<Group justify="space-between">
						<Stack gap={0}>
							<Text size="sm" c="dimmed">
								{t('updates.current_version')}
							</Text>
							<Title order={3}>{data.current_version}</Title>
						</Stack>
						<Badge color={stateColor(data.state)} size="lg">
							{t(`updates.state_${data.state}`)}
						</Badge>
					</Group>

					{data.last_checked_at && (
						<Text size="sm" c="dimmed">
							{t('updates.last_checked')}: {data.last_checked_at.replace('T', ' ').slice(0, 19)}
						</Text>
					)}

					{data.update_available && data.latest_version && (
						<Alert color="cyan" icon={<IconArrowUp size={18} />} title={t('updates.available_title')}>
							<Stack gap="xs">
								<Text>
									{t('updates.available_message', {
										current: data.current_version,
										latest: data.latest_version,
									})}
								</Text>
								{data.release_notes_url && (
									<Anchor href={data.release_notes_url} target="_blank" size="sm">
										{t('updates.release_notes_link')}
									</Anchor>
								)}
								<Group>
									<Button
										leftSection={<IconArrowUp size={16} />}
										onClick={onInstall}
										loading={install.isPending}
									>
										{t('updates.install_button')}
									</Button>
								</Group>
							</Stack>
						</Alert>
					)}

					{!data.update_available && data.state !== 'failed' && (
						<Alert color="green" icon={<IconCircleCheck size={18} />}>
							{t('updates.up_to_date')}
						</Alert>
					)}

					{data.last_error && (
						<Alert color="red" icon={<IconAlertCircle size={18} />} title={t('updates.error_title')}>
							<Code>{data.last_error}</Code>
						</Alert>
					)}

					<Box>
						<Button
							variant="light"
							leftSection={<IconRefresh size={16} />}
							onClick={onCheck}
							loading={check.isPending}
						>
							{t('updates.check_now')}
						</Button>
					</Box>
				</Stack>
			</Card>

			<Card withBorder>
				<Stack>
					<Title order={4}>{t('updates.settings_title')}</Title>
					<Group justify="space-between">
						<Stack gap={0}>
							<Text>{t('updates.channel')}</Text>
							<Text size="xs" c="dimmed">
								{t('updates.channel_hint')}
							</Text>
						</Stack>
						<Select
							value={data.channel}
							onChange={(v) => v && void onSettingsChange(v as UpdateStatus['channel'], data.mode)}
							data={[
								{ value: 'stable', label: t('updates.channel_stable') },
								{ value: 'prerelease', label: t('updates.channel_prerelease') },
								{ value: 'nightly', label: t('updates.channel_nightly') },
								{ value: 'disabled', label: t('updates.channel_disabled') },
							]}
							w={200}
						/>
					</Group>
					<Group justify="space-between">
						<Stack gap={0}>
							<Text>{t('updates.mode')}</Text>
							<Text size="xs" c="dimmed">
								{t('updates.mode_hint')}
							</Text>
						</Stack>
						<Select
							value={data.mode}
							onChange={(v) => v && void onSettingsChange(data.channel, v as UpdateStatus['mode'])}
							data={[
								{ value: 'notify', label: t('updates.mode_notify') },
								{ value: 'auto', label: t('updates.mode_auto') },
							]}
							w={200}
						/>
					</Group>
				</Stack>
			</Card>
		</Stack>
	);
}
