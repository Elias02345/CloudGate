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
	Progress,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck, IconPlugConnected, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.js';
import {
	useAddPlayitAccount,
	useDeletePlayitAccount,
	usePlayitAccounts,
	usePlayitQuota,
} from '../api/playit.js';
import { useConfirm } from '../components/ConfirmProvider.js';
import { EmptyState } from '../components/EmptyState.js';
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

export function PlayitPage() {
	const { t } = useTranslation();
	const confirm = useConfirm();
	const accounts = usePlayitAccounts();
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [modalOpened, modal] = useDisclosure(false);
	const addMutation = useAddPlayitAccount();
	const deleteMutation = useDeletePlayitAccount();
	const quota = usePlayitQuota(selectedId);

	const [label, setLabel] = useState('');
	const [secretKey, setSecretKey] = useState('');

	const onAdd = async (): Promise<void> => {
		try {
			const result = await addMutation.mutateAsync({ label, secret_key: secretKey });
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('playit.linked_title'),
				message: t('playit.linked_message', { label: result.account.label }),
			});
			setLabel('');
			setSecretKey('');
			modal.close();
		} catch {
			/* surfaced inline below */
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
				<Title order={2}>{t('playit.title')}</Title>
				<Button leftSection={<IconPlugConnected size={18} />} onClick={modal.open}>
					{t('playit.link_account')}
				</Button>
			</Group>

			<Card withBorder>
				<Stack>
					<Text size="sm" c="dimmed">
						{t('playit.hint')}{' '}
						<Anchor href="https://playit.gg/account/agents" target="_blank">
							playit.gg
						</Anchor>{' '}
						{t('playit.hint_suffix')}
					</Text>

					{accounts.isLoading && <ListSkeleton rows={3} />}
					{accounts.data?.accounts.length === 0 && (
						<EmptyState icon={<IconPlugConnected size={40} stroke={1.5} />} title={t('playit.empty')} />
					)}

					{accounts.data && accounts.data.accounts.length > 0 && (
						<>
							<Box visibleFrom="sm">
								<Table.ScrollContainer minWidth={600}>
									<Table>
										<Table.Thead>
											<Table.Tr>
												<Table.Th w={127}>{t('playit.col_label')}</Table.Th>
												<Table.Th ta="center" w={363}>
													{t('playit.col_status')}
												</Table.Th>
												<Table.Th w={307}>{t('playit.col_linked')}</Table.Th>
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
													<Table.Td ta="center">
														<Badge color={a.status === 'active' ? 'green' : 'gray'} variant="light">
															{a.status}
														</Badge>
													</Table.Td>
													<Table.Td>
														<Text size="xs" c="dimmed">
															{a.created_at?.replace('T', ' ').slice(0, 16) ?? '—'}
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
																			title: t('playit.unlink_title'),
																			message: t('playit.confirm_delete', { label: a.label }),
																			danger: true,
																		}))
																	)
																		return;
																	void deleteMutation.mutate(a.id);
																	if (selectedId === a.id) setSelectedId(null);
																}}
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
												<Badge color={a.status === 'active' ? 'green' : 'gray'} variant="light">
													{a.status}
												</Badge>
											</Group>
											<InfoLine label={t('playit.col_linked')}>
												<Text size="xs" c="dimmed">
													{a.created_at?.replace('T', ' ').slice(0, 16) ?? '—'}
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
																title: t('playit.unlink_title'),
																message: t('playit.confirm_delete', { label: a.label }),
																danger: true,
															}))
														)
															return;
														void deleteMutation.mutate(a.id);
														if (selectedId === a.id) setSelectedId(null);
													}}
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
						<Title order={4}>{t('playit.quota_title')}</Title>
						{quota.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
						{quota.data && (
							<Stack gap="md">
								<Box>
									<Group justify="space-between" mb={4}>
										<Text size="sm">{t('playit.tcp_tunnels')}</Text>
										<Text size="sm" c="dimmed">
											{quota.data.quota.tcp_used} / {quota.data.quota.tcp_limit}
										</Text>
									</Group>
									<Progress
										value={(quota.data.quota.tcp_used / quota.data.quota.tcp_limit) * 100}
										color={quota.data.quota.tcp_used >= quota.data.quota.tcp_limit ? 'red' : 'blue'}
									/>
								</Box>
								<Box>
									<Group justify="space-between" mb={4}>
										<Text size="sm">{t('playit.udp_tunnels')}</Text>
										<Text size="sm" c="dimmed">
											{quota.data.quota.udp_used} / {quota.data.quota.udp_limit}
										</Text>
									</Group>
									<Progress
										value={(quota.data.quota.udp_used / quota.data.quota.udp_limit) * 100}
										color={quota.data.quota.udp_used >= quota.data.quota.udp_limit ? 'red' : 'blue'}
									/>
								</Box>
								{(quota.data.quota.tcp_used >= quota.data.quota.tcp_limit ||
									quota.data.quota.udp_used >= quota.data.quota.udp_limit) && (
									<Alert color="orange">
										{t('playit.quota_cap_reached')}{' '}
										<Anchor href="https://playit.gg/account/billing" target="_blank">
											playit.gg/account/billing
										</Anchor>{' '}
										{t('playit.quota_cap_reached_suffix')}
									</Alert>
								)}
							</Stack>
						)}
					</Stack>
				</Card>
			)}

			<Modal opened={modalOpened} onClose={modal.close} title={t('playit.link_modal_title')} size="md">
				<Stack>
					<Text size="sm" c="dimmed">
						{t('playit.get_secret_hint')}{' '}
						<Anchor href="https://playit.gg/account/agents" target="_blank">
							playit.gg/account/agents
						</Anchor>
						{t('playit.get_secret_hint_suffix')}
					</Text>
					{addError && (
						<Alert color="red" icon={<IconAlertCircle size={18} />}>
							{addError}
						</Alert>
					)}
					<TextInput
						label={t('playit.label_field')}
						placeholder={t('playit.label_placeholder')}
						value={label}
						onChange={(e) => setLabel(e.currentTarget.value)}
						required
					/>
					<PasswordInput
						label={t('playit.secret_field')}
						placeholder={t('playit.secret_placeholder')}
						value={secretKey}
						onChange={(e) => setSecretKey(e.currentTarget.value)}
						required
					/>
					<Box>
						<Button onClick={onAdd} loading={addMutation.isPending} disabled={!label || !secretKey}>
							{t('playit.validate_and_link')}
						</Button>
					</Box>
				</Stack>
			</Modal>
		</Stack>
	);
}
