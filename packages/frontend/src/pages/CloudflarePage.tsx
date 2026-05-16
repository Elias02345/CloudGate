import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Card,
	Group,
	Modal,
	PasswordInput,
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
	IconCloudPlus,
	IconRefresh,
	IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	useAddCloudflareAccount,
	useCloudflareAccounts,
	useDeleteCloudflareAccount,
	useSyncZones,
	useZones,
} from '../api/cloudflare.js';
import { ApiError } from '../api/client.js';

export function CloudflarePage() {
	const { t } = useTranslation();
	const accounts = useCloudflareAccounts();
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [modalOpened, modal] = useDisclosure(false);
	const addMutation = useAddCloudflareAccount();
	const deleteMutation = useDeleteCloudflareAccount();
	const zones = useZones(selectedId);
	const sync = useSyncZones(selectedId);

	const [label, setLabel] = useState('');
	const [apiToken, setApiToken] = useState('');

	const onAdd = async () => {
		try {
			const result = await addMutation.mutateAsync({ label, api_token: apiToken });
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('cloudflare.added_title'),
				message: t('cloudflare.added_message', { label: result.account.label }),
			});
			setLabel('');
			setApiToken('');
			modal.close();
		} catch {
			/* error surfaced inline below */
		}
	};

	const addError =
		addMutation.error instanceof ApiError
			? `${addMutation.error.message} (${addMutation.error.code})`
			: addMutation.error
				? t('login.unknown_error')
				: null;

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t('cloudflare.title')}</Title>
				<Button leftSection={<IconCloudPlus size={18} />} onClick={modal.open}>
					{t('cloudflare.add_account')}
				</Button>
			</Group>

			<Card withBorder>
				<Stack>
					<Text size="sm" c="dimmed">
						{t('cloudflare.hint')}{' '}
						<Anchor href="https://github.com/Elias02345/CloudGate/blob/dev/docs/CLOUDFLARE_SETUP.md" target="_blank">
							{t('cloudflare.docs_link')}
						</Anchor>
					</Text>

					{accounts.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{accounts.data?.accounts.length === 0 && (
						<Text c="dimmed" ta="center" py="md">
							{t('cloudflare.empty')}
						</Text>
					)}

					{accounts.data && accounts.data.accounts.length > 0 && (
						<Table>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t('cloudflare.col_label')}</Table.Th>
									<Table.Th>{t('cloudflare.col_account_tag')}</Table.Th>
									<Table.Th>{t('cloudflare.col_auth')}</Table.Th>
									<Table.Th>{t('cloudflare.col_last_validated')}</Table.Th>
									<Table.Th />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{accounts.data.accounts.map((a) => (
									<Table.Tr
										key={a.id}
										style={{ cursor: 'pointer', background: selectedId === a.id ? 'var(--mantine-color-dark-6)' : undefined }}
										onClick={() => setSelectedId(a.id)}
									>
										<Table.Td>
											<Text fw={500}>{a.label}</Text>
										</Table.Td>
										<Table.Td>
											<Text c="dimmed" size="xs" ff="monospace">
												{a.account_tag.slice(0, 12)}…
											</Text>
										</Table.Td>
										<Table.Td>
											<Badge variant="light">{a.auth_type}</Badge>
										</Table.Td>
										<Table.Td>
											<Text size="xs" c="dimmed">
												{a.last_validated_at?.replace('T', ' ').slice(0, 16) ?? '—'}
											</Text>
										</Table.Td>
										<Table.Td>
											<ActionIcon
												variant="subtle"
												color="red"
												onClick={(e) => {
													e.stopPropagation();
													if (confirm(t('cloudflare.confirm_delete', { label: a.label }))) {
														void deleteMutation.mutate(a.id);
														if (selectedId === a.id) setSelectedId(null);
													}
												}}
											>
												<IconTrash size={16} />
											</ActionIcon>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					)}
				</Stack>
			</Card>

			{selectedId !== null && (
				<Card withBorder>
					<Stack>
						<Group justify="space-between">
							<Title order={4}>{t('cloudflare.zones_title')}</Title>
							<Button
								size="xs"
								variant="light"
								leftSection={<IconRefresh size={14} />}
								loading={sync.isPending}
								onClick={() => void sync.mutate()}
							>
								{t('cloudflare.sync')}
							</Button>
						</Group>
						{zones.data?.zones.length === 0 && (
							<Text c="dimmed">{t('cloudflare.no_zones')}</Text>
						)}
						{zones.data && zones.data.zones.length > 0 && (
							<Table>
								<Table.Thead>
									<Table.Tr>
										<Table.Th>{t('cloudflare.col_zone_name')}</Table.Th>
										<Table.Th>{t('cloudflare.col_status')}</Table.Th>
										<Table.Th>{t('cloudflare.col_zone_id')}</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{zones.data.zones.map((z) => (
										<Table.Tr key={z.id}>
											<Table.Td>{z.name}</Table.Td>
											<Table.Td>
												<Badge color={z.status === 'active' ? 'green' : 'gray'}>{z.status}</Badge>
											</Table.Td>
											<Table.Td>
												<Text size="xs" ff="monospace" c="dimmed">
													{z.zone_id}
												</Text>
											</Table.Td>
										</Table.Tr>
									))}
								</Table.Tbody>
							</Table>
						)}
					</Stack>
				</Card>
			)}

			<Modal opened={modalOpened} onClose={modal.close} title={t('cloudflare.add_account')} size="md">
				<Stack>
					<Text size="sm" c="dimmed">
						{t('cloudflare.add_hint')}{' '}
						<Anchor href="https://github.com/Elias02345/CloudGate/blob/dev/docs/CLOUDFLARE_SETUP.md" target="_blank">
							{t('cloudflare.add_hint_link')}
						</Anchor>
					</Text>
					{addError && (
						<Alert color="red" icon={<IconAlertCircle size={18} />}>
							{addError}
						</Alert>
					)}
					<TextInput
						label={t('cloudflare.label_field')}
						placeholder="main account"
						value={label}
						onChange={(e) => setLabel(e.currentTarget.value)}
						required
					/>
					<PasswordInput
						label={t('cloudflare.token_field')}
						placeholder="cf-..."
						value={apiToken}
						onChange={(e) => setApiToken(e.currentTarget.value)}
						required
					/>
					<Box>
						<Button onClick={onAdd} loading={addMutation.isPending} disabled={!label || !apiToken}>
							{t('cloudflare.validate_and_add')}
						</Button>
					</Box>
				</Stack>
			</Modal>
		</Stack>
	);
}
