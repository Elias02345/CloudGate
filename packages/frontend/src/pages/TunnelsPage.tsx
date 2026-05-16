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
	IconRefresh,
	IconRoutePlus,
	IconTerminal2,
	IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudflareAccounts } from '../api/cloudflare.js';
import { ApiError } from '../api/client.js';
import {
	type TunnelDto,
	useCreateTunnel,
	useDeleteTunnel,
	useRestartTunnel,
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
	const createMutation = useCreateTunnel();
	const deleteMutation = useDeleteTunnel();
	const restartMutation = useRestartTunnel();

	const [modalOpened, modal] = useDisclosure(false);
	const [drawerOpened, drawer] = useDisclosure(false);
	const [logsForId, setLogsForId] = useState<number | null>(null);
	const [name, setName] = useState('');
	const [accountId, setAccountId] = useState<string | null>(null);

	const logs = useTunnelLogs(logsForId);

	const onCreate = async () => {
		if (!accountId) return;
		try {
			const r = await createMutation.mutateAsync({
				cloudflare_account_id: Number.parseInt(accountId, 10),
				name,
			});
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('tunnels.created_title'),
				message: t('tunnels.created_message', { name: r.tunnel.name }),
			});
			setName('');
			setAccountId(null);
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
				<Button leftSection={<IconRoutePlus size={18} />} onClick={modal.open}>
					{t('tunnels.create')}
				</Button>
			</Group>

			<Card withBorder>
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
											<Badge color={statusColor(row.live_status)}>{row.live_status}</Badge>
										</Table.Td>
										<Table.Td>
											<Code>{row.tunnel_id.slice(0, 8)}…</Code>
										</Table.Td>
										<Table.Td>
											<Text size="xs" c="dimmed">
												{row.last_status_at?.replace('T', ' ').slice(0, 16) ?? '—'}
											</Text>
										</Table.Td>
										<Table.Td>
											<Group gap="xs" justify="flex-end">
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
					{accounts.data?.accounts.length === 0 && (
						<Alert color="orange">{t('tunnels.no_account_warning')}</Alert>
					)}
					{createError && (
						<Alert color="red" icon={<IconAlertCircle size={18} />}>
							{createError}
						</Alert>
					)}
					<Select
						label={t('tunnels.account_field')}
						placeholder={t('tunnels.pick_account')}
						value={accountId}
						onChange={setAccountId}
						data={
							accounts.data?.accounts.map((a) => ({
								value: String(a.id),
								label: a.label,
							})) ?? []
						}
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
		</Stack>
	);
}
