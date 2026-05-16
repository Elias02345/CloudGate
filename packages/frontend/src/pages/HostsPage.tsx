import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Card,
	Group,
	Stack,
	Switch,
	Table,
	Text,
	Title,
} from '@mantine/core';
import { IconAlertCircle, IconCirclePlus, IconExternalLink, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@mantine/core';
import { useDeleteHost, useHosts, useToggleHost } from '../api/hosts.js';

export function HostsPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const hosts = useHosts();
	const toggleMutation = useToggleHost();
	const deleteMutation = useDeleteHost();

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t('hosts.title')}</Title>
				<Button leftSection={<IconCirclePlus size={18} />} onClick={() => navigate('/hosts/new')}>
					{t('hosts.add')}
				</Button>
			</Group>

			<Card withBorder>
				<Stack>
					{hosts.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{hosts.data?.hosts.length === 0 && (
						<Text c="dimmed" ta="center" py="md">
							{t('hosts.empty')}
						</Text>
					)}
					{hosts.data && hosts.data.hosts.length > 0 && (
						<Table verticalSpacing="sm">
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t('hosts.col_hostname')}</Table.Th>
									<Table.Th>{t('hosts.col_target')}</Table.Th>
									<Table.Th>{t('hosts.col_mode')}</Table.Th>
									<Table.Th>{t('hosts.col_status')}</Table.Th>
									<Table.Th>{t('hosts.col_enabled')}</Table.Th>
									<Table.Th />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{hosts.data.hosts.map((h) => (
									<Table.Tr key={h.id}>
										<Table.Td>
											<Group gap={4}>
												<Text fw={500}>{h.hostname}</Text>
												{h.enabled && (
													<ActionIcon
														variant="subtle"
														size="sm"
														component="a"
														href={`https://${h.hostname}`}
														target="_blank"
														rel="noreferrer"
													>
														<IconExternalLink size={14} />
													</ActionIcon>
												)}
											</Group>
										</Table.Td>
										<Table.Td>
											<Text ff="monospace" size="sm">
												{h.forward_scheme}://{h.forward_host}:{h.forward_port}
											</Text>
										</Table.Td>
										<Table.Td>
											<Badge variant="light">
												{h.mode === 'cloudflare_tunnel' ? t('hosts.mode_tunnel') : t('hosts.mode_nginx')}
											</Badge>
										</Table.Td>
										<Table.Td>
											{h.last_error ? (
												<Badge color="red" title={h.last_error}>
													{t('hosts.status_error')}
												</Badge>
											) : h.last_deployed_at ? (
												<Badge color="green">{t('hosts.status_deployed')}</Badge>
											) : (
												<Badge color="yellow">{t('hosts.status_pending')}</Badge>
											)}
										</Table.Td>
										<Table.Td>
											<Switch
												checked={h.enabled}
												onChange={() => void toggleMutation.mutate(h.id)}
												aria-label={t('hosts.enabled_toggle')}
											/>
										</Table.Td>
										<Table.Td>
											<ActionIcon
												variant="subtle"
												color="red"
												onClick={() => {
													if (confirm(t('hosts.confirm_delete', { hostname: h.hostname }))) {
														void deleteMutation.mutate(h.id);
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

			{hosts.data?.hosts.some((h) => h.last_error) && (
				<Alert color="red" icon={<IconAlertCircle size={18} />} title={t('hosts.errors_present_title')}>
					{t('hosts.errors_present_body')}{' '}
					<Anchor href="https://github.com/Elias02345/CloudGate/blob/dev/docs/CLOUDFLARE_SETUP.md" target="_blank">
						{t('hosts.docs_link')}
					</Anchor>
				</Alert>
			)}
		</Stack>
	);
}
