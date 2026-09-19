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
	Paper,
	PasswordInput,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck, IconCloudPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.js';
import {
	useAddCloudflareAccount,
	useCloudflareAccounts,
	useDeleteCloudflareAccount,
	useSyncZones,
	useZones,
} from '../api/cloudflare.js';
import { useConfirm } from '../components/ConfirmProvider.js';
import { EmptyState } from '../components/EmptyState.js';
import { ListError } from '../components/ListError.js';
import { ListSkeleton } from '../components/ListSkeleton.js';

function InfoLine({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Group gap={6} wrap="nowrap" align="baseline">
			<Text size="xs" c="dimmed" w={88} style={{ flexShrink: 0 }}>
				{label}
			</Text>
			<Box style={{ minWidth: 0 }}>{children}</Box>
		</Group>
	);
}

export function CloudflarePage() {
	const { t } = useTranslation();
	const confirm = useConfirm();
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
			<Group justify="space-between" wrap="wrap" gap="sm">
				<Title order={2}>{t('cloudflare.title')}</Title>
				<Button leftSection={<IconCloudPlus size={18} />} onClick={modal.open}>
					{t('cloudflare.add_account')}
				</Button>
			</Group>

			<Card withBorder data-tour="cloudflare-accounts">
				<Stack>
					<Text size="sm" c="dimmed">
						{t('cloudflare.hint')}{' '}
						<Anchor
							href="https://github.com/Elias02345/CloudGate/blob/dev/docs/CLOUDFLARE_SETUP.md"
							target="_blank"
						>
							{t('cloudflare.docs_link')}
						</Anchor>
					</Text>

					{accounts.isLoading && <ListSkeleton rows={3} />}
					{accounts.isError && <ListError error={accounts.error} onRetry={() => void accounts.refetch()} />}
					{!accounts.isError && accounts.data?.accounts.length === 0 && (
						<EmptyState
							icon={<IconCloudPlus size={40} stroke={1.5} />}
							title={t('cloudflare.empty')}
							action={
								<Button variant="light" leftSection={<IconCloudPlus size={16} />} onClick={modal.open}>
									{t('cloudflare.add_account')}
								</Button>
							}
						/>
					)}

					{accounts.data && accounts.data.accounts.length > 0 && (
						<>
							<Box visibleFrom="sm">
								<Table.ScrollContainer minWidth={700}>
									<Table>
										<Table.Thead>
											<Table.Tr>
												<Table.Th w={218}>{t('cloudflare.col_label')}</Table.Th>
												<Table.Th w={115}>{t('cloudflare.col_account_tag')}</Table.Th>
												<Table.Th ta="center" w={355}>
													{t('cloudflare.col_auth')}
												</Table.Th>
												<Table.Th w={309}>{t('cloudflare.col_last_validated')}</Table.Th>
												<Table.Th />
											</Table.Tr>
										</Table.Thead>
										<Table.Tbody>
											{accounts.data.accounts.map((a) => (
												<Table.Tr
													key={a.id}
													className="cg-clickable"
													data-selected={selectedId === a.id || undefined}
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
													<Table.Td ta="center">
														<Badge variant="light">{a.auth_type}</Badge>
													</Table.Td>
													<Table.Td>
														<Text size="xs" c="dimmed">
															{a.last_validated_at?.replace('T', ' ').slice(0, 16) ?? '—'}
														</Text>
													</Table.Td>
													<Table.Td>
														<Group justify="flex-end">
															<ActionIcon
																variant="subtle"
																color="red"
																onClick={async (e) => {
																	e.stopPropagation();
																	if (
																		!(await confirm({
																			title: t('cloudflare.delete_title'),
																			message: t('cloudflare.confirm_delete', { label: a.label }),
																			confirmLabel: t('common.delete'),
																			danger: true,
																		}))
																	)
																		return;
																	void deleteMutation.mutate(a.id);
																	if (selectedId === a.id) setSelectedId(null);
																}}
																title={t('cloudflare.delete_title')}
															>
																<IconTrash size={16} />
															</ActionIcon>
														</Group>
													</Table.Td>
												</Table.Tr>
											))}
										</Table.Tbody>
									</Table>
								</Table.ScrollContainer>
							</Box>
							<Stack gap="xs" hiddenFrom="sm">
								{accounts.data.accounts.map((a) => (
									<Paper
										key={a.id}
										withBorder
										radius="md"
										p="sm"
										className="cg-clickable"
										data-selected={selectedId === a.id || undefined}
										onClick={() => setSelectedId(a.id)}
									>
										<Stack gap={6}>
											<Group justify="space-between" wrap="nowrap" align="flex-start">
												<Text fw={600} style={{ wordBreak: 'break-word', minWidth: 0 }}>
													{a.label}
												</Text>
												<Badge variant="light">{a.auth_type}</Badge>
											</Group>
											<InfoLine label={t('cloudflare.col_account_tag')}>
												<Text ff="monospace" size="xs" truncate="end" title={a.account_tag}>
													{a.account_tag}
												</Text>
											</InfoLine>
											<InfoLine label={t('cloudflare.col_last_validated')}>
												<Text size="xs" c="dimmed">
													{a.last_validated_at?.replace('T', ' ').slice(0, 16) ?? '—'}
												</Text>
											</InfoLine>
											<Group gap="xs" justify="flex-end">
												<ActionIcon
													variant="subtle"
													color="red"
													size="lg"
													onClick={async (e) => {
														e.stopPropagation();
														if (
															!(await confirm({
																title: t('cloudflare.delete_title'),
																message: t('cloudflare.confirm_delete', { label: a.label }),
																confirmLabel: t('common.delete'),
																danger: true,
															}))
														)
															return;
														void deleteMutation.mutate(a.id);
														if (selectedId === a.id) setSelectedId(null);
													}}
													title={t('cloudflare.delete_title')}
												>
													<IconTrash size={18} />
												</ActionIcon>
											</Group>
										</Stack>
									</Paper>
								))}
							</Stack>
						</>
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
						{zones.data?.zones.length === 0 && <Text c="dimmed">{t('cloudflare.no_zones')}</Text>}
						{zones.data && zones.data.zones.length > 0 && (
							<>
								<Box visibleFrom="sm">
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
								</Box>
								<Stack gap="xs" hiddenFrom="sm">
									{zones.data.zones.map((z) => (
										<Paper key={z.id} withBorder radius="md" p="sm">
											<Stack gap={6}>
												<Group justify="space-between" wrap="nowrap" align="flex-start">
													<Text fw={600} style={{ wordBreak: 'break-word', minWidth: 0 }}>
														{z.name}
													</Text>
													<Badge color={z.status === 'active' ? 'green' : 'gray'}>{z.status}</Badge>
												</Group>
												<InfoLine label={t('cloudflare.col_zone_id')}>
													<Text size="xs" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
														{z.zone_id}
													</Text>
												</InfoLine>
											</Stack>
										</Paper>
									))}
								</Stack>
							</>
						)}
					</Stack>
				</Card>
			)}

			<Modal opened={modalOpened} onClose={modal.close} title={t('cloudflare.add_account')} size="md">
				<Stack>
					<Text size="sm" c="dimmed">
						{t('cloudflare.add_hint')}{' '}
						<Anchor
							href="https://github.com/Elias02345/CloudGate/blob/dev/docs/CLOUDFLARE_SETUP.md"
							target="_blank"
						>
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
