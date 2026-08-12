/**
 * Edit a host's forwarding settings without delete+recreate.
 *
 * Everything except hostname/mode is editable — including the tunnel
 * and DNS zone, so users can recover from orphaned hosts (migration
 * 008) and move hosts between tunnels.
 *
 * When tunnel/zone change, the backend tears down the old deployment
 * (deletes the old DNS record, drops the host from the old tunnel's
 * ingress) before persisting and re-deploying — no orphan DNS records.
 */

import {
	Alert,
	Anchor,
	Box,
	Button,
	Checkbox,
	Code,
	Collapse,
	CopyButton,
	Divider,
	Group,
	Modal,
	NumberInput,
	Select,
	Stack,
	Text,
	TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
	IconAlertCircle,
	IconAlertTriangle,
	IconBulb,
	IconCheck,
	IconChevronDown,
	IconChevronUp,
	IconCopy,
	IconCopyCheck,
	IconExchange,
	IconStethoscope,
} from '@tabler/icons-react';
import type { TFunction } from 'i18next';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useZones } from '../api/cloudflare.js';
import { type HostDto, type ProbeOutcome, useDiagnoseHost, useUpdateHost } from '../api/hosts.js';
import { useTunnels } from '../api/tunnels.js';

const HOME_ASSISTANT_DOCS_URL = 'https://github.com/Elias02345/CloudGate/blob/dev/docs/HOME-ASSISTANT.md';

interface EditHostModalProps {
	host: HostDto | null;
	opened: boolean;
	onClose: () => void;
}

export function EditHostModal({ host, opened, onClose }: EditHostModalProps) {
	const { t } = useTranslation();
	const update = useUpdateHost();
	const tunnels = useTunnels();
	const diagnose = useDiagnoseHost();
	const [diagnoseResult, setDiagnoseResult] = useState<ProbeOutcome | null>(null);
	const [advancedOpen, advanced] = useDisclosure(false);
	const [reassignOpen, reassign] = useDisclosure(false);
	const form = useForm({
		initialValues: {
			tunnel_id: '' as string,
			cf_zone_id: '' as string,
			forward_scheme: 'http' as 'http' | 'https',
			forward_host: '',
			forward_port: 80,
			path_prefix: '/',
			no_tls_verify: false,
			http_host_header: '',
			forwarded_headers: 'standard' as 'standard' | 'client_ip_only' | 'strip',
			origin_server_name: '',
			no_happy_eyeballs: false,
			http2_origin: false,
			disable_chunked_encoding: false,
			connect_timeout_seconds: 30,
		},
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional — only re-init when the modal opens for a different host
	useEffect(() => {
		if (!host) return;
		const adv = host.advanced_options ?? {};
		form.setValues({
			tunnel_id: host.tunnel_id ? String(host.tunnel_id) : '',
			cf_zone_id: host.cf_zone_id ? String(host.cf_zone_id) : '',
			forward_scheme: host.forward_scheme,
			forward_host: host.forward_host,
			forward_port: host.forward_port,
			path_prefix: host.path_prefix,
			no_tls_verify: Boolean(host.tls_options?.no_tls_verify),
			http_host_header: adv.http_host_header ?? '',
			forwarded_headers: adv.forwarded_headers ?? 'standard',
			origin_server_name: adv.origin_server_name ?? '',
			no_happy_eyeballs: Boolean(adv.no_happy_eyeballs),
			http2_origin: Boolean(adv.http2_origin),
			disable_chunked_encoding: Boolean(adv.disable_chunked_encoding),
			connect_timeout_seconds: adv.connect_timeout_seconds ?? 30,
		});
		setDiagnoseResult(null);
		// Auto-open the reassign panel if the host is currently orphaned —
		// the user almost certainly opened this modal to fix that.
		if (!host.tunnel_id) {
			reassign.open();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host?.id]);

	// Eligible tunnels for the current host's protocol — playit can't
	// carry HTTP and vice versa.
	const eligibleTunnels = useMemo(() => {
		const protocol = host?.protocol ?? 'http';
		return (tunnels.data?.tunnels ?? []).filter((tn) =>
			protocol === 'http' || protocol === 'https' ? tn.provider === 'cloudflared' : tn.provider === 'playit'
		);
	}, [tunnels.data, host?.protocol]);

	const selectedTunnelId = form.values.tunnel_id ? Number.parseInt(form.values.tunnel_id, 10) : null;
	const selectedTunnel = eligibleTunnels.find((tn) => tn.id === selectedTunnelId);
	const zonesAccountId = selectedTunnel?.cloudflare_account_id ?? null;
	const zones = useZones(zonesAccountId);

	const tunnelChanged = host && form.values.tunnel_id !== (host.tunnel_id ? String(host.tunnel_id) : '');
	const zoneChanged = host && form.values.cf_zone_id !== (host.cf_zone_id ? String(host.cf_zone_id) : '');
	const hostnameMatchesZone = (() => {
		const zoneId = form.values.cf_zone_id ? Number.parseInt(form.values.cf_zone_id, 10) : null;
		if (!zoneId) return true;
		const z = zones.data?.zones.find((zone) => zone.id === zoneId);
		if (!z || !host) return true;
		return host.hostname.endsWith(z.name);
	})();

	const onSubmit = form.onSubmit(async (values) => {
		if (!host) return;
		try {
			const advanced_options = {
				...(values.http_host_header ? { http_host_header: values.http_host_header } : {}),
				...(values.forwarded_headers && values.forwarded_headers !== 'standard'
					? { forwarded_headers: values.forwarded_headers }
					: {}),
				...(values.origin_server_name ? { origin_server_name: values.origin_server_name } : {}),
				...(values.no_happy_eyeballs ? { no_happy_eyeballs: true } : {}),
				...(values.http2_origin ? { http2_origin: true } : {}),
				...(values.disable_chunked_encoding ? { disable_chunked_encoding: true } : {}),
				...(values.connect_timeout_seconds && values.connect_timeout_seconds !== 30
					? { connect_timeout_seconds: values.connect_timeout_seconds }
					: {}),
			};
			const payload: Parameters<typeof update.mutateAsync>[0]['input'] = {
				forward_scheme: values.forward_scheme,
				forward_host: values.forward_host,
				forward_port: values.forward_port,
				path_prefix: values.path_prefix,
				tls_options: { no_tls_verify: values.no_tls_verify },
				advanced_options,
			};
			if (tunnelChanged && values.tunnel_id) {
				payload.tunnel_id = Number.parseInt(values.tunnel_id, 10);
			}
			if (zoneChanged && values.cf_zone_id) {
				payload.cf_zone_id = Number.parseInt(values.cf_zone_id, 10);
			}
			await update.mutateAsync({ id: host.id, input: payload });
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('hosts.edit_saved_title'),
				message: t('hosts.edit_saved_message', { hostname: host.hostname }),
			});
			onClose();
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	});

	const onDiagnose = async () => {
		if (!host) return;
		setDiagnoseResult(null);
		try {
			const result = await diagnose.mutateAsync(host.id);
			setDiagnoseResult(result);
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const guessIsHttpsTarget = guessHttpsForPort(form.values.forward_port);
	const schemeMismatch =
		guessIsHttpsTarget && form.values.forward_scheme === 'http' && host?.last_error?.includes('Wrong scheme');

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t('hosts.edit_title', { hostname: host?.hostname ?? '' })}
			size="md"
		>
			<form onSubmit={onSubmit}>
				<Stack>
					{schemeMismatch && (
						<Alert color="yellow" icon={<IconBulb size={18} />} variant="light">
							{t('hosts.edit_scheme_hint')}
						</Alert>
					)}
					{/* The origin diagnosis is the whole point of opening this modal on a
					    broken host, so it sits at the top rather than inside the
					    collapsed Advanced panel. `last_error` can be a multi-line block
					    (the Home Assistant remedy includes YAML), which is unreadable in
					    the host list's tooltip — render it properly here. */}
					{host?.last_error && (
						<Alert
							color="red"
							icon={<IconAlertCircle size={18} />}
							title={t('hosts.last_error_title')}
							variant="light"
						>
							<Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
								{host.last_error}
							</Text>
						</Alert>
					)}
					{host && (
						<Group>
							<Button
								variant="light"
								size="xs"
								leftSection={<IconStethoscope size={14} />}
								onClick={() => void onDiagnose()}
								loading={diagnose.isPending}
							>
								{t('hosts.diagnose_button')}
							</Button>
							<Text size="xs" c="dimmed">
								{t('hosts.diagnose_hint')}
							</Text>
						</Group>
					)}
					{diagnoseResult && <DiagnoseResultPanel result={diagnoseResult} t={t} />}
					{host && !host.tunnel_id && (
						<Alert color="orange" icon={<IconAlertCircle size={18} />} title="Host has no tunnel">
							This host lost its tunnel assignment during a previous upgrade. Use the{' '}
							<strong>Reassign tunnel/zone</strong> section below to attach it again — DNS and ingress will be
							re-created on save.
						</Alert>
					)}

					<Button
						variant="subtle"
						size="xs"
						leftSection={reassignOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
						onClick={reassign.toggle}
						style={{ alignSelf: 'flex-start' }}
					>
						<Group gap={6}>
							<IconExchange size={14} />
							<Text size="xs" inherit>
								Reassign tunnel / zone
							</Text>
							{(tunnelChanged || zoneChanged) && (
								<Text size="xs" c="orange" inherit>
									(changed)
								</Text>
							)}
						</Group>
					</Button>
					<Collapse in={reassignOpen}>
						<Stack gap="sm">
							<Alert color="blue" variant="light">
								<Text size="xs">
									Moving a host between tunnels (or zones) deletes the old DNS record and creates a new one,
									then redeploys. Expect a few seconds of downtime while DNS converges.
								</Text>
							</Alert>
							<Select
								label="Tunnel"
								placeholder="Pick a tunnel"
								data={eligibleTunnels.map((tn) => ({
									value: String(tn.id),
									label: `${tn.name} (${tn.provider})`,
								}))}
								{...form.getInputProps('tunnel_id')}
							/>
							<Select
								label="DNS zone"
								placeholder={zones.isLoading ? 'Loading…' : 'Pick a zone'}
								disabled={!zonesAccountId}
								data={zones.data?.zones.map((z) => ({ value: String(z.id), label: z.name })) ?? []}
								{...form.getInputProps('cf_zone_id')}
								error={
									!hostnameMatchesZone && form.values.cf_zone_id
										? `Hostname '${host?.hostname ?? ''}' does not end with this zone`
										: undefined
								}
							/>
						</Stack>
					</Collapse>
					<Divider />

					{host && (
						<Text size="sm" c="dimmed">
							{t('hosts.edit_immutable_note', { hostname: host.hostname })}
						</Text>
					)}
					<Group grow>
						<Select
							label={t('hosts.scheme_field')}
							data={[
								{ value: 'http', label: 'http://' },
								{ value: 'https', label: 'https://' },
							]}
							{...form.getInputProps('forward_scheme')}
						/>
						<TextInput
							label={t('hosts.forward_host_field')}
							placeholder="192.168.1.10"
							{...form.getInputProps('forward_host')}
						/>
					</Group>
					<NumberInput
						label={t('hosts.forward_port_field')}
						min={1}
						max={65535}
						{...form.getInputProps('forward_port')}
					/>
					<TextInput
						label={t('hosts.path_prefix_field')}
						placeholder="/"
						{...form.getInputProps('path_prefix')}
					/>
					{form.values.forward_scheme === 'https' && (
						<Checkbox
							label={t('hosts.no_tls_verify_label')}
							description={t('hosts.no_tls_verify_hint')}
							{...form.getInputProps('no_tls_verify', { type: 'checkbox' })}
						/>
					)}

					<Button
						variant="subtle"
						size="xs"
						leftSection={advancedOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
						onClick={advanced.toggle}
						style={{ alignSelf: 'flex-start' }}
					>
						{t('hosts.advanced_panel_title')}
					</Button>
					<Collapse in={advancedOpen}>
						<Stack gap="sm">
							<Alert color="blue" variant="light">
								<Text size="xs">
									{t('hosts.advanced_ha_hint')}{' '}
									<Anchor href={HOME_ASSISTANT_DOCS_URL} target="_blank">
										{t('hosts.advanced_ha_docs_link')}
									</Anchor>
								</Text>
							</Alert>
							<TextInput
								label={t('hosts.http_host_header_label')}
								description={t('hosts.http_host_header_hint')}
								placeholder="homeassistant.local:8123"
								{...form.getInputProps('http_host_header')}
							/>
							<Select
								label={t('hosts.forwarded_headers_label')}
								description={
									host?.mode === 'cloudflare_tunnel'
										? t('hosts.forwarded_headers_tunnel_note')
										: t('hosts.forwarded_headers_hint')
								}
								disabled={host?.mode === 'cloudflare_tunnel'}
								data={[
									{ value: 'standard', label: t('hosts.forwarded_headers_standard') },
									{ value: 'client_ip_only', label: t('hosts.forwarded_headers_client_ip_only') },
									{ value: 'strip', label: t('hosts.forwarded_headers_strip') },
								]}
								{...form.getInputProps('forwarded_headers')}
							/>
							{form.values.forwarded_headers === 'strip' && (
								<Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
									<Text size="xs">{t('hosts.forwarded_headers_strip_warning')}</Text>
								</Alert>
							)}
							<TextInput
								label={t('hosts.origin_server_name_label')}
								description={t('hosts.origin_server_name_hint')}
								placeholder="my-app.local"
								{...form.getInputProps('origin_server_name')}
							/>
							<Group grow>
								<Checkbox
									label={t('hosts.http2_origin_label')}
									description={t('hosts.http2_origin_hint')}
									{...form.getInputProps('http2_origin', { type: 'checkbox' })}
								/>
								<Checkbox
									label={t('hosts.no_happy_eyeballs_label')}
									description={t('hosts.no_happy_eyeballs_hint')}
									{...form.getInputProps('no_happy_eyeballs', { type: 'checkbox' })}
								/>
							</Group>
							<Checkbox
								label={t('hosts.disable_chunked_encoding_label')}
								description={t('hosts.disable_chunked_encoding_hint')}
								{...form.getInputProps('disable_chunked_encoding', { type: 'checkbox' })}
							/>
							<NumberInput
								label={t('hosts.connect_timeout_label')}
								description={t('hosts.connect_timeout_hint')}
								min={1}
								max={600}
								{...form.getInputProps('connect_timeout_seconds')}
							/>
							<Text size="xs" c="dimmed">
								{t('hosts.advanced_full_list')}{' '}
								<Anchor
									href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/cloudflared-parameters/origin-parameters/"
									target="_blank"
								>
									{t('hosts.advanced_full_list_link')}
								</Anchor>
							</Text>
						</Stack>
					</Collapse>

					<Box>
						<Button
							type="submit"
							loading={update.isPending}
							disabled={!hostnameMatchesZone && Boolean(form.values.cf_zone_id)}
						>
							{t('common.save')}
						</Button>
					</Box>
				</Stack>
			</form>
		</Modal>
	);
}

/** Heuristic: common ports that are HTTPS-only by default. */
function guessHttpsForPort(port: number): boolean {
	return [443, 8443, 8006, 9090, 9443, 4443].includes(port);
}

function diagnoseColor(kind: ProbeOutcome['kind']): string {
	if (kind === 'ok') return 'green';
	if (kind === 'forwarded_header_rejected') return 'red';
	if (kind === 'skipped') return 'gray';
	return 'yellow';
}

/** Renders the result of GET /hosts/:id/diagnose. `forwarded_header_rejected` gets
 * the full treatment — it's the one outcome with an actionable, copy-pasteable fix. */
function DiagnoseResultPanel({ result, t }: { result: ProbeOutcome; t: TFunction }) {
	const color = diagnoseColor(result.kind);
	const icon =
		result.kind === 'ok' ? (
			<IconCheck size={18} />
		) : result.kind === 'forwarded_header_rejected' ? (
			<IconAlertTriangle size={18} />
		) : (
			<IconAlertCircle size={18} />
		);
	const title =
		result.kind === 'ok'
			? t('hosts.diagnose_title_ok')
			: result.kind === 'forwarded_header_rejected'
				? t('hosts.diagnose_title_fhr')
				: t('hosts.diagnose_title_other');

	return (
		<Alert color={color} icon={icon} title={title} variant="light">
			{result.kind === 'ok' ? (
				<Text size="sm">
					{t('hosts.diagnose_result_ok', { status: result.statusCode, latency: result.latency_ms })}
				</Text>
			) : (
				<Stack gap="xs">
					<Text size="sm">{result.message}</Text>
					{result.kind === 'forwarded_header_rejected' && (
						<>
							{result.diagnosis.proxy_source_ip && (
								<Text size="xs" c="dimmed">
									{t('hosts.diagnose_proxy_ip', {
										ip: result.diagnosis.proxy_source_cidr ?? result.diagnosis.proxy_source_ip,
									})}
								</Text>
							)}
							{result.diagnosis.remedy_yaml && (
								<Box>
									<Group justify="space-between" align="center" mb={4}>
										<Text size="xs" fw={600}>
											{t('hosts.diagnose_remedy_label')}
										</Text>
										<CopyButton value={result.diagnosis.remedy_yaml}>
											{({ copied, copy }) => (
												<Button
													size="xs"
													variant="light"
													color={copied ? 'green' : 'blue'}
													leftSection={copied ? <IconCopyCheck size={14} /> : <IconCopy size={14} />}
													onClick={copy}
												>
													{copied ? t('hosts.diagnose_copied') : t('hosts.diagnose_copy')}
												</Button>
											)}
										</CopyButton>
									</Group>
									<Code block>{result.diagnosis.remedy_yaml}</Code>
								</Box>
							)}
							<Text size="xs">
								<Anchor href={HOME_ASSISTANT_DOCS_URL} target="_blank">
									{t('hosts.diagnose_docs_link')}
								</Anchor>
							</Text>
						</>
					)}
				</Stack>
			)}
		</Alert>
	);
}
