import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Code,
	Drawer,
	Group,
	Modal,
	Select,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
	IconAlertCircle,
	IconCheck,
	IconCirclePlus,
	IconFileText,
	IconRefresh,
	IconRefreshDot,
	IconTerminal2,
	IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.js';
import { useCloudflareAccounts } from '../api/cloudflare.js';
import { usePlayitAccounts } from '../api/playit.js';
import {
	type TunnelDto,
	useCreateTunnel,
	useDeleteTunnel,
	useRedeployAllHosts,
	useRestartTunnel,
	useTunnelConfig,
	useTunnelLogs,
	useTunnels,
} from '../api/tunnels.js';

function statusColor(s: string): string {
	switch (s) {
		case 'running':
			return 'green';
		case 'starting':
			return 'yellow';
		case 'stopped':
			return 'gray';
		case 'error':
			return 'red';
		default:
			return 'gray';
	}
}

export function TunnelsPage() {
	const { t } = useTranslation();
	const tunnels = useTunnels();
	const accounts = useCloudflareAccounts();
	const playitAccounts = usePlayitAccounts();
	const createMutation = useCreateTunnel();
	const deleteMutation = useDeleteTunnel();
	const restartMutation = useRestartTunnel();

	const [modalOpened, modal] = useDisclosure(false);
	const [drawerOpened, drawer] = useDisclosure(false);
	const [configDrawerOpened, configDrawer] = useDisclosure(false);
	const [logsForId, setLogsForId] = useState<number | null>(null);
	const [configForId, setConfigForId] = useState<number | null>(null);
	const [name, setName] = useState('');
	const [provider, setProvider] = useState<'cloudflared' | 'playit'>('cloudflared');
	const [accountId, setAccountId] = useState<string | null>(null);

	const providerAccounts = useMemo(() => {
		if (provider === 'playit') {
			return (playitAccounts.data?.accounts ?? []).map((a) => ({ value: String(a.id), label: a.label }));
		}
		return (accounts.data?.accounts ?? []).map((a) => ({ value: String(a.id), label: a.label }));
	}, [provider, accounts.data, playitAccounts.data]);

	const logs = useTunnelLogs(logsForId);
	const config = useTunnelConfig(configForId);
	const redeployAll = useRedeployAllHosts();

	const onShowConfig = (id: number) => {
		setConfigForId(id);
		configDrawer.open();
	};

	const onRedeployAll = async (id: number, name: string) => {
		if (!confirm(t('tunnels.confirm_redeploy_all', { name }))) return;
		try {
			const r = await redeployAll.mutateAsync(id);
			if (r.failed > 0) {
				notifications.show({
					color: 'orange',
					title: t('tunnels.redeploy_partial_title'),
					message: t('tunnels.redeploy_partial_message', { ok: r.ok, failed: r.failed }),
					autoClose: 8000,
				});
			} else {
				notifications.show({
					color: 'green',
					title: t('tunnels.redeploy_ok_title'),
					message: t('tunnels.redeploy_ok_message', { ok: r.ok }),
				});
			}
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const onCreate = async (): Promise<void> => {
		if (!accountId) return;
		try {
			const payload =
				provider === 'playit'
					? { provider: 'playit' as const, playit_account_id: Number.parseInt(accountId, 10), name }
					: { provider: 'cloudflared' as const, cloudflare_account_id: Number.parseInt(accountId, 10), name };
			const r = await createMutation.mutateAsync(payload);
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('tunnels.created_title'),
				message: t('tunnels.created_message', { name: r.tunnel.name }),
			});
			setName('');
			setAccountId(null);
			setProvider('cloudflared');
			modal.close();
		} catch {
			/* surfaced inline */
		}
	};

	const openLogs = (row: TunnelDto) => {
		setLogsForId(row.id);
		drawer.open();
	};

	const createError =
		createMutation.error instanceof ApiError
			? `${createMutation.error.message} (${createMutation.error.code})`
			: createMutation.error
				? t('login.unknown_error')
				: null;

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t('tunnels.title')}</Title>
				<Button leftSection={<IconCirclePlus size={18} />} onClick={modal.open}>
					{t('tunnels.create')}
				</Button>
			</Group>

			<Card withBorder data-tour="tunnels-list">
				<Stack>
					{tunnels.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{tunnels.data?.tunnels.length === 0 && (
						<Text c="dimmed" ta="center" py="md">
							{t('tunnels.empty')}
						</Text>
					)}
					{tunnels.data && tunnels.data.tunnels.length > 0 && (
						<Table verticalSpacing="sm">
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t('tunnels.col_name')}</Table.Th>
									<Table.Th>Provider</Table.Th>
									<Table.Th>{t('tunnels.col_status')}</Table.Th>
									<Table.Th>{t('tunnels.col_tunnel_id')}</Table.Th>
									<Table.Th>{t('tunnels.col_last_change')}</Table.Th>
									<Table.Th />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{tunnels.data.tunnels.map((row) => (
									<Table.Tr key={row.id}>
										<Table.Td>
											<Text fw={500}>{row.name}</Text>
										</Table.Td>
										<Table.Td>
											<Badge variant="light" color={row.provider === 'playit' ? 'orange' : 'blue'}>
												{row.provider}
											</Badge>
										</Table.Td>
										<Table.Td>
											<Badge color={statusColor(row.live_status)}>{row.live_status}</Badge>
										</Table.Td>
										<Table.Td>
											<Code>{row.tunnel_id.slice(0, 12)}…</Code>
										</Table.Td>
										<Table.Td>
											<Text size="xs" c="dimmed">
												{row.last_status_at?.replace('T', ' ').slice(0, 16) ?? '—'}
											</Text>
										</Table.Td>
										<Table.Td>
											<Group gap="xs" justify="flex-end">
												<ActionIcon
													variant="subtle"
													color="grape"
													onClick={() => onShowConfig(row.id)}
													title={t('tunnels.show_config')}
												>
													<IconFileText size={16} />
												</ActionIcon>
												<ActionIcon
													variant="subtle"
													color="cyan"
													onClick={() => void onRedeployAll(row.id, row.name)}
													loading={redeployAll.isPending}
													title={t('tunnels.redeploy_all')}
												>
													<IconRefreshDot size={16} />
												</ActionIcon>
												<ActionIcon variant="subtle" onClick={() => openLogs(row)} title={t('tunnels.logs')}>
													<IconTerminal2 size={16} />
												</ActionIcon>
												<ActionIcon
													variant="subtle"
													color="yellow"
													onClick={() => void restartMutation.mutate(row.id)}
													title={t('tunnels.restart')}
												>
													<IconRefresh size={16} />
												</ActionIcon>
												<ActionIcon
													variant="subtle"
													color="red"
													onClick={() => {
														if (confirm(t('tunnels.confirm_delete', { name: row.name }))) {
															void deleteMutation.mutate(row.id);
														}
													}}
													title={t('common.delete')}
												>
													<IconTrash size={16} />
												</ActionIcon>
											</Group>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					)}
				</Stack>
			</Card>

			<Modal opened={modalOpened} onClose={modal.close} title={t('tunnels.create')} size="md">
				<Stack>
					{createError && (
						<Alert color="red" icon={<IconAlertCircle size={18} />}>
							{createError}
						</Alert>
					)}
					<Select
						label="Provider"
						description="cloudflared = HTTP/HTTPS apps. playit = Minecraft / raw TCP+UDP."
						value={provider}
						onChange={(v) => {
							if (v === 'cloudflared' || v === 'playit') {
								setProvider(v);
								setAccountId(null);
							}
						}}
						data={[
							{ value: 'cloudflared', label: 'cloudflared (Cloudflare Tunnel)' },
							{ value: 'playit', label: 'playit.gg (TCP/UDP)' },
						]}
					/>
					{provider === 'cloudflared' && accounts.data?.accounts.length === 0 && (
						<Alert color="orange">{t('tunnels.no_account_warning')}</Alert>
					)}
					{provider === 'playit' && playitAccounts.data?.accounts.length === 0 && (
						<Alert color="orange">
							No Playit accounts linked. Add one under Playit in the sidebar first.
						</Alert>
					)}
					<Select
						label={provider === 'playit' ? 'Playit account' : t('tunnels.account_field')}
						placeholder={t('tunnels.pick_account')}
						value={accountId}
						onChange={setAccountId}
						data={providerAccounts}
						required
					/>
					<TextInput
						label={t('tunnels.name_field')}
						placeholder="homelab"
						description={t('tunnels.name_hint')}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						required
					/>
					<Box>
						<Button
							onClick={onCreate}
							loading={createMutation.isPending}
							disabled={!accountId || !name || !/^[a-zA-Z0-9-_]+$/.test(name)}
						>
							{t('tunnels.submit')}
						</Button>
					</Box>
				</Stack>
			</Modal>

			<Drawer
				opened={drawerOpened}
				onClose={() => {
					drawer.close();
					setLogsForId(null);
				}}
				title={t('tunnels.logs_title')}
				size="xl"
				position="right"
			>
				<Stack>
					{logs.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{logs.data && (
						<Code block style={{ maxHeight: '70vh', overflow: 'auto' }}>
							{logs.data.logs.length === 0 ? t('tunnels.no_logs') : logs.data.logs.join('\n')}
						</Code>
					)}
				</Stack>
			</Drawer>

			<Drawer
				opened={configDrawerOpened}
				onClose={() => {
					configDrawer.close();
					setConfigForId(null);
				}}
				title={t('tunnels.config_title')}
				size="xl"
				position="right"
			>
				<Stack>
					{config.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{config.data && (
						<>
							<Box>
								<Text size="sm" fw={600}>
									{t('tunnels.config_hosts_in_db')} ({config.data.hosts.length})
								</Text>
								<Stack gap={4} mt={4}>
									{config.data.hosts.length === 0 ? (
										<Text size="xs" c="dimmed">
											{t('tunnels.config_no_hosts')}
										</Text>
									) : (
										config.data.hosts.map((h) => {
											const yaml = config.data?.yaml ?? '';
											const inConfig =
												config.data?.tunnel.provider === 'cloudflared'
													? yaml.includes(`hostname: ${h.hostname}`)
													: true;
											return (
												<Group key={h.id} gap="xs">
													{inConfig ? (
														<Badge color="green" size="xs">
															IN CONFIG
														</Badge>
													) : (
														<Badge color="red" size="xs">
															MISSING
														</Badge>
													)}
													<Text size="xs" ff="monospace">
														{h.hostname} → {h.forward_scheme}://{h.forward_host}:{h.forward_port}
													</Text>
													{!h.enabled && (
														<Badge color="gray" size="xs">
															DISABLED
														</Badge>
													)}
												</Group>
											);
										})
									)}
								</Stack>
							</Box>
							{config.data.tunnel.provider === 'cloudflared' && config.data.yaml && (
								<Box>
									<Text size="sm" fw={600}>
										{t('tunnels.config_rendered_yaml')}
									</Text>
									<Code block style={{ maxHeight: '50vh', overflow: 'auto' }} mt={4}>
										{config.data.yaml}
									</Code>
								</Box>
							)}
							{config.data.tunnel.provider === 'playit' && config.data.provider_meta !== undefined && (
								<Box>
									<Text size="sm" fw={600}>
										Playit provider metadata
									</Text>
									<Code block style={{ maxHeight: '50vh', overflow: 'auto' }} mt={4}>
										{JSON.stringify(config.data.provider_meta, null, 2)}
									</Code>
								</Box>
							)}
							<Text size="xs" c="dimmed">
								{t('tunnels.config_hint')}
							</Text>
						</>
					)}
				</Stack>
			</Drawer>
		</Stack>
	);
}
