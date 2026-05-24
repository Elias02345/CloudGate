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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.js';
import {
	useAddPlayitAccount,
	useDeletePlayitAccount,
	usePlayitAccounts,
	usePlayitQuota,
} from '../api/playit.js';

export function PlayitPage() {
	const { t } = useTranslation();
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
				title: 'Playit account linked',
				message: `${result.account.label} is ready for game-server tunnels.`,
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
			<Group justify="space-between">
				<Title order={2}>Playit.gg accounts</Title>
				<Button leftSection={<IconPlugConnected size={18} />} onClick={modal.open}>
					Link account
				</Button>
			</Group>

			<Card withBorder>
				<Stack>
					<Text size="sm" c="dimmed">
						Playit hosts your Minecraft + raw TCP/UDP tunnels. Sign up free at{' '}
						<Anchor href="https://playit.gg/account/agents" target="_blank">
							playit.gg
						</Anchor>{' '}
						and paste the agent secret here. Free tier: 4 TCP + 4 UDP tunnels per account.
					</Text>

					{accounts.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{accounts.data?.accounts.length === 0 && (
						<Text c="dimmed" ta="center" py="md">
							No Playit accounts linked yet. Add one to host Minecraft / TCP / UDP services.
						</Text>
					)}

					{accounts.data && accounts.data.accounts.length > 0 && (
						<Table>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>Label</Table.Th>
									<Table.Th>Status</Table.Th>
									<Table.Th>Linked</Table.Th>
									<Table.Th />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{accounts.data.accounts.map((a) => (
									<Table.Tr
										key={a.id}
										style={{
											cursor: 'pointer',
											background: selectedId === a.id ? 'var(--mantine-color-dark-6)' : undefined,
										}}
										onClick={() => setSelectedId(a.id)}
									>
										<Table.Td>
											<Text fw={500}>{a.label}</Text>
										</Table.Td>
										<Table.Td>
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
											<ActionIcon
												variant="subtle"
												color="red"
												onClick={(e) => {
													e.stopPropagation();
													if (confirm(`Unlink Playit account "${a.label}"?`)) {
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
						<Title order={4}>Tunnel quota</Title>
						{quota.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
						{quota.data && (
							<Stack gap="md">
								<Box>
									<Group justify="space-between" mb={4}>
										<Text size="sm">TCP tunnels</Text>
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
										<Text size="sm">UDP tunnels</Text>
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
										Free-tier cap reached. Upgrade at{' '}
										<Anchor href="https://playit.gg/account/billing" target="_blank">
											playit.gg/account/billing
										</Anchor>{' '}
										to add more tunnels.
									</Alert>
								)}
							</Stack>
						)}
					</Stack>
				</Card>
			)}

			<Modal opened={modalOpened} onClose={modal.close} title="Link a Playit.gg account" size="md">
				<Stack>
					<Text size="sm" c="dimmed">
						Get an agent secret at{' '}
						<Anchor href="https://playit.gg/account/agents" target="_blank">
							playit.gg/account/agents
						</Anchor>
						. Click "New Agent" → copy the secret string.
					</Text>
					{addError && (
						<Alert color="red" icon={<IconAlertCircle size={18} />}>
							{addError}
						</Alert>
					)}
					<TextInput
						label="Label"
						placeholder="homelab gaming"
						value={label}
						onChange={(e) => setLabel(e.currentTarget.value)}
						required
					/>
					<PasswordInput
						label="Agent secret"
						placeholder="paste the secret string from playit.gg"
						value={secretKey}
						onChange={(e) => setSecretKey(e.currentTarget.value)}
						required
					/>
					<Box>
						<Button onClick={onAdd} loading={addMutation.isPending} disabled={!label || !secretKey}>
							Validate and link
						</Button>
					</Box>
				</Stack>
			</Modal>
		</Stack>
	);
}
