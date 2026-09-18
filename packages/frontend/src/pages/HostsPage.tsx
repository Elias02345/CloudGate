import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Card,
	Group,
	Paper,
	Stack,
	Switch,
	Table,
	Text,
	Title,
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
import { type ReactElement, type ReactNode, useState } from 'react';
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
import { CopyButton } from '../components/CopyButton.js';
import { EditHostModal } from '../components/EditHostModal.js';
import { EmptyState } from '../components/EmptyState.js';
import { ListSkeleton } from '../components/ListSkeleton.js';
import { Tooltip } from '../components/Tooltip.js';

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

function lastTwoLabels(host: string): string {
	const labels = host.split('.');
	return labels.length <= 2 ? host : labels.slice(-2).join('.');
}

function shortEdgeEndpoint(edge: HostDto['edge_endpoint']): string | null {
	if (!edge) return null;
	if (edge.kind === 'srv') {
		const labels = edge.target.split('.');
		return labels.length <= 2
			? `${edge.target}:${edge.port} (via SRV)`
			: `•••.${lastTwoLabels(edge.target)} (SRV)`;
	}
	if (edge.kind === 'host_port') {
		const labels = edge.target.split('.');
		return labels.length <= 2 ? `${edge.target}:${edge.port}` : `•••.${lastTwoLabels(edge.target)}`;
	}
	if (edge.kind === 'cname') {
		const labels = edge.target.split('.');
		return labels.length <= 2 ? edge.target : `•••.${lastTwoLabels(edge.target)}`;
	}
	return null;
}

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
			<Group justify="space-between" wrap="wrap" gap="sm">
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
					{hosts.isLoading && <ListSkeleton rows={4} />}
					{hosts.data?.hosts.length === 0 && (
						<EmptyState
							icon={<IconWorld size={40} stroke={1.5} />}
							title={t('hosts.empty')}
							action={
								<Button
									variant="light"
									leftSection={<IconCirclePlus size={16} />}
									onClick={() => navigate('/hosts/new')}
								>
									{t('hosts.add')}
								</Button>
							}
						/>
					)}
					{hosts.data && hosts.data.hosts.length > 0 && (
						<Box visibleFrom="sm">
							<Table.ScrollContainer minWidth={1000}>
								<Table verticalSpacing="sm">
									<Table.Thead>
										<Table.Tr>
											<Table.Th ta="center" w={210}>
												{t('hosts.col_hostname')}
											</Table.Th>
											<Table.Th ta="center" w={105}>
												Type
											</Table.Th>
											<Table.Th ta="center" w={205}>
												{t('hosts.col_target')}
											</Table.Th>
											<Table.Th ta="center" w={233}>
												Public endpoint
											</Table.Th>
											<Table.Th ta="center" w={89}>
												{t('hosts.col_status')}
											</Table.Th>
											<Table.Th ta="center" w={91}>
												{t('hosts.col_enabled')}
											</Table.Th>
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
														<Group gap={4} wrap="nowrap">
															<Text fw={500} style={{ whiteSpace: 'nowrap' }}>
																{h.hostname}
															</Text>
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
													<Table.Td ta="center">
														<Badge variant="light" color={proto.color} leftSection={proto.icon}>
															{proto.label}
														</Badge>
													</Table.Td>
													<Table.Td ta="center">
														<Text ff="monospace" size="sm">
															{isWebish
																? `${h.forward_scheme}://${h.forward_host}:${h.forward_port}`
																: `${h.forward_host}:${h.forward_port}`}
														</Text>
													</Table.Td>
													<Table.Td ta="center">
														{endpointStr ? (
															<Group gap={4} justify="center" wrap="nowrap">
																<Text ff="monospace" size="xs" c="dimmed" title={endpointStr}>
																	{shortEdgeEndpoint(h.edge_endpoint)}
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
													<Table.Td ta="center">
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
													<Table.Td ta="center">
														<Group justify="center">
															<Switch
																checked={h.enabled}
																onChange={() => void toggleMutation.mutate(h.id)}
																aria-label={t('hosts.enabled_toggle')}
															/>
														</Group>
													</Table.Td>
													<Table.Td>
														<Group gap={4} justify="flex-end" wrap="nowrap">
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
							</Table.ScrollContainer>
						</Box>
					)}
					{hosts.data && hosts.data.hosts.length > 0 && (
						<Stack gap="xs" hiddenFrom="sm">
							{hosts.data.hosts.map((h) => {
								const proto = protocolBadge(h.protocol ?? 'http');
								const isWebish = h.protocol === 'http' || h.protocol === 'https';
								const endpointStr = edgeEndpointString(h.edge_endpoint);
								return (
									<Paper key={h.id} withBorder radius="md" p="sm">
										<Stack gap={6}>
											<Group justify="space-between" wrap="nowrap" align="flex-start">
												<Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
													<Text fw={600} style={{ wordBreak: 'break-word' }}>
														{h.hostname}
													</Text>
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
												<Switch
													checked={h.enabled}
													onChange={() => void toggleMutation.mutate(h.id)}
													aria-label={t('hosts.enabled_toggle')}
												/>
											</Group>
											<Group gap="xs">
												<Badge variant="light" color={proto.color} leftSection={proto.icon}>
													{proto.label}
												</Badge>
												{h.last_error ? (
													<Badge color="red" title={h.last_error}>
														{t('hosts.status_error')}
													</Badge>
												) : h.last_deployed_at ? (
													<Badge color="green">{t('hosts.status_deployed')}</Badge>
												) : (
													<Badge color="yellow">{t('hosts.status_pending')}</Badge>
												)}
											</Group>
											<InfoLine label={t('hosts.col_target')}>
												<Text ff="monospace" size="xs" style={{ wordBreak: 'break-all' }}>
													{isWebish
														? `${h.forward_scheme}://${h.forward_host}:${h.forward_port}`
														: `${h.forward_host}:${h.forward_port}`}
												</Text>
											</InfoLine>
											<InfoLine label="Public endpoint">
												{endpointStr ? (
													<Group gap={4} wrap="nowrap">
														<Text ff="monospace" size="xs" c="dimmed" title={endpointStr}>
															{shortEdgeEndpoint(h.edge_endpoint)}
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
											</InfoLine>
											<Group gap="xs" justify="flex-end">
												{h.mode === 'cloudflare_tunnel' && (
													<ActionIcon
														variant="subtle"
														color="grape"
														size="lg"
														onClick={() => void onVerifyDns(h.id, h.hostname)}
														loading={verifyDns.isPending}
														title={t('hosts.verify_dns')}
													>
														<IconWorldSearch size={18} />
													</ActionIcon>
												)}
												<ActionIcon
													variant="subtle"
													color="blue"
													size="lg"
													onClick={() => setEditingHost(h)}
													title={t('hosts.edit')}
												>
													<IconEdit size={18} />
												</ActionIcon>
												{h.last_error && (
													<ActionIcon
														variant="subtle"
														color="orange"
														size="lg"
														onClick={() => void onRedeploy(h.id, h.hostname)}
														loading={redeployMutation.isPending}
														title={t('hosts.redeploy')}
													>
														<IconRefresh size={18} />
													</ActionIcon>
												)}
												{h.mode === 'local_nginx' && (
													<ActionIcon
														variant="subtle"
														color="cyan"
														size="lg"
														onClick={() => void onIssue(h.hostname)}
														loading={issueCert.isPending}
														title={t('hosts.issue_cert')}
													>
														<IconCertificate size={18} />
													</ActionIcon>
												)}
												<ActionIcon
													variant="subtle"
													color="red"
													size="lg"
													onClick={() => {
														if (confirm(t('hosts.confirm_delete', { hostname: h.hostname }))) {
															void deleteMutation.mutate(h.id);
														}
													}}
												>
													<IconTrash size={18} />
												</ActionIcon>
											</Group>
										</Stack>
									</Paper>
								);
							})}
						</Stack>
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
