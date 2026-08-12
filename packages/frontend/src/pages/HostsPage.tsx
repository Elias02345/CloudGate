import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Card,
	CopyButton,
	Group,
	Stack,
	Switch,
	Table,
	Text,
	Title,
	Tooltip,
} from '@mantine/core';
import { Button } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
	IconAlertCircle,
	IconCertificate,
	IconCirclePlus,
	IconCopy,
	IconCopyCheck,
	IconDeviceGamepad2,
	IconEdit,
	IconExternalLink,
	IconNetwork,
	IconRefresh,
	IconTrash,
	IconUpload,
	IconWorld,
	IconWorldSearch,
} from '@tabler/icons-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useIssueCert } from '../api/acme.js';
import {
	type HostDto,
	useDeleteHost,
	useHosts,
	useRedeployHost,
	useToggleHost,
	useVerifyDns,
} from '../api/hosts.js';
import { BulkImportModal } from '../components/BulkImportModal.js';
import { EditHostModal } from '../components/EditHostModal.js';

function protocolBadge(protocol: string): { icon: ReactElement; label: string; color: string } {
	switch (protocol) {
		case 'tcp':
			return { icon: <IconNetwork size={12} />, label: 'TCP', color: 'cyan' };
		case 'udp':
			return { icon: <IconDeviceGamepad2 size={12} />, label: 'UDP', color: 'orange' };
		case 'https':
			return { icon: <IconWorld size={12} />, label: 'HTTPS', color: 'green' };
		default:
			return { icon: <IconWorld size={12} />, label: 'HTTP', color: 'blue' };
	}
}

function edgeEndpointString(edge: HostDto['edge_endpoint']): string | null {
	if (!edge) return null;
	if (edge.kind === 'srv') return `${edge.target}:${edge.port} (via SRV)`;
	if (edge.kind === 'host_port') return `${edge.target}:${edge.port}`;
	if (edge.kind === 'cname') return edge.target;
	return null;
}

export function HostsPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const hosts = useHosts();
	const toggleMutation = useToggleHost();
	const deleteMutation = useDeleteHost();
	const redeployMutation = useRedeployHost();
	const verifyDns = useVerifyDns();
	const issueCert = useIssueCert();
	const [bulkOpened, bulkModal] = useDisclosure(false);
	const [editingHost, setEditingHost] = useState<HostDto | null>(null);

	const onVerifyDns = async (id: number, hostname: string) => {
		try {
			const result = await verifyDns.mutateAsync(id);
			if (result.result.kind === 'ok') {
				notifications.show({
					color: 'green',
					title: t('hosts.dns_verify_ok_title'),
					message: t('hosts.dns_verify_ok_message', {
						hostname,
						target: result.result.cname,
						ttl: result.result.ttl,
					}),
				});
			} else {
				notifications.show({
					color: 'orange',
					title: t('hosts.dns_verify_warn_title'),
					message:
						'message' in result.result
							? result.result.message
							: t('hosts.dns_verify_warn_message', { kind: result.result.kind }),
					autoClose: 8000,
				});
			}
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const onRedeploy = async (id: number, hostname: string) => {
		try {
			await redeployMutation.mutateAsync(id);
			notifications.show({
				color: 'green',
				title: t('hosts.redeploy_ok_title'),
				message: t('hosts.redeploy_ok_message', { hostname }),
			});
		} catch (err) {
			notifications.show({
				color: 'red',
				title: t('hosts.redeploy_failed_title'),
				message: (err as Error).message,
			});
		}
	};

	const onIssue = async (hostname: string) => {
		if (!confirm(t('hosts.confirm_issue_cert', { hostname }))) return;
		try {
			const r = await issueCert.mutateAsync({ hostname });
			notifications.show({
				color: 'green',
				title: t('hosts.cert_issued_title'),
				message: t('hosts.cert_issued_message', { hostname, expires: r.expires_at.slice(0, 10) }),
			});
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t('hosts.title')}</Title>
				<Group gap="xs" data-tour="hosts-add-btn">
					<Button variant="default" leftSection={<IconUpload size={16} />} onClick={bulkModal.open}>
						{t('bulk.button')}
					</Button>
					<Button leftSection={<IconCirclePlus size={18} />} onClick={() => navigate('/hosts/new')}>
						{t('hosts.add')}
					</Button>
				</Group>
			</Group>
			<BulkImportModal opened={bulkOpened} onClose={bulkModal.close} />

			<Card withBorder data-tour="hosts-mode-switch">
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
									<Table.Th>Type</Table.Th>
									<Table.Th>{t('hosts.col_target')}</Table.Th>
									<Table.Th>Public endpoint</Table.Th>
									<Table.Th>{t('hosts.col_status')}</Table.Th>
									<Table.Th>{t('hosts.col_enabled')}</Table.Th>
									<Table.Th />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{hosts.data.hosts.map((h) => {
									const proto = protocolBadge(h.protocol ?? 'http');
									const isWebish = h.protocol === 'http' || h.protocol === 'https';
									const endpointStr = edgeEndpointString(h.edge_endpoint);
									return (
										<Table.Tr key={h.id}>
											<Table.Td>
												<Group gap={4}>
													<Text fw={500}>{h.hostname}</Text>
													{h.enabled && isWebish && (
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
												<Badge variant="light" color={proto.color} leftSection={proto.icon}>
													{proto.label}
												</Badge>
											</Table.Td>
											<Table.Td>
												<Text ff="monospace" size="sm">
													{isWebish
														? `${h.forward_scheme}://${h.forward_host}:${h.forward_port}`
														: `${h.forward_host}:${h.forward_port}`}
												</Text>
											</Table.Td>
											<Table.Td>
												{endpointStr ? (
													<Group gap={4}>
														<Text ff="monospace" size="xs" c="dimmed">
															{endpointStr}
														</Text>
														<CopyButton value={endpointStr}>
															{({ copied, copy }) => (
																<Tooltip label={copied ? 'Copied' : 'Copy endpoint'}>
																	<ActionIcon variant="subtle" size="sm" onClick={copy}>
																		{copied ? <IconCopyCheck size={14} /> : <IconCopy size={14} />}
																	</ActionIcon>
																</Tooltip>
															)}
														</CopyButton>
													</Group>
												) : (
													<Text size="xs" c="dimmed">
														—
													</Text>
												)}
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
												<Group gap={4} justify="flex-end">
													{h.mode === 'cloudflare_tunnel' && (
														<ActionIcon
															variant="subtle"
															color="grape"
															onClick={() => void onVerifyDns(h.id, h.hostname)}
															loading={verifyDns.isPending}
															title={t('hosts.verify_dns')}
														>
															<IconWorldSearch size={16} />
														</ActionIcon>
													)}
													<ActionIcon
														variant="subtle"
														color="blue"
														onClick={() => setEditingHost(h)}
														title={t('hosts.edit')}
													>
														<IconEdit size={16} />
													</ActionIcon>
													{h.last_error && (
														<ActionIcon
															variant="subtle"
															color="orange"
															onClick={() => void onRedeploy(h.id, h.hostname)}
															loading={redeployMutation.isPending}
															title={t('hosts.redeploy')}
														>
															<IconRefresh size={16} />
														</ActionIcon>
													)}
													{h.mode === 'local_nginx' && (
														<ActionIcon
															variant="subtle"
															color="cyan"
															onClick={() => void onIssue(h.hostname)}
															loading={issueCert.isPending}
															title={t('hosts.issue_cert')}
														>
															<IconCertificate size={16} />
														</ActionIcon>
													)}
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
												</Group>
											</Table.Td>
										</Table.Tr>
									);
								})}
							</Table.Tbody>
						</Table>
					)}
				</Stack>
			</Card>

			{hosts.data?.hosts.some((h) => h.last_error) && (
				<Alert color="red" icon={<IconAlertCircle size={18} />} title={t('hosts.errors_present_title')}>
					{t('hosts.errors_present_body')}{' '}
					<Anchor
						href="https://github.com/Elias02345/CloudGate/blob/dev/docs/CLOUDFLARE_SETUP.md"
						target="_blank"
					>
						{t('hosts.docs_link')}
					</Anchor>
				</Alert>
			)}

			<EditHostModal host={editingHost} opened={!!editingHost} onClose={() => setEditingHost(null)} />
		</Stack>
	);
}
