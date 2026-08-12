import {
	Alert,
	Badge,
	Button,
	Card,
	Checkbox,
	Group,
	NumberInput,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck, IconInfoCircle } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useCloudflareAccounts, useZones } from '../api/cloudflare.js';
import { type CreateHostInput, useCreateHost } from '../api/hosts.js';
import { useTunnels } from '../api/tunnels.js';

const HOSTNAME_RX = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

type HostType = 'web' | 'minecraft_java' | 'minecraft_bedrock' | 'raw_tcp' | 'raw_udp';

interface HostTypeSpec {
	protocol: 'http' | 'https' | 'tcp' | 'udp';
	provider: 'cloudflared' | 'playit';
	defaultPort: number;
	defaultHost: string;
	requiresZone: boolean;
	showScheme: boolean;
	showPath: boolean;
	srvService?: string;
	srvProto?: '_tcp' | '_udp';
	label: string;
	hint: string;
}

const HOST_TYPES: Record<HostType, HostTypeSpec> = {
	web: {
		protocol: 'http',
		provider: 'cloudflared',
		defaultPort: 8080,
		defaultHost: '192.168.1.10',
		requiresZone: true,
		showScheme: true,
		showPath: true,
		label: 'Web app (HTTP/HTTPS)',
		hint: 'Standard reverse proxy over Cloudflare Tunnel — any HTTP service.',
	},
	minecraft_java: {
		protocol: 'tcp',
		provider: 'playit',
		defaultPort: 25565,
		defaultHost: '192.168.1.50',
		requiresZone: true,
		showScheme: false,
		showPath: false,
		srvService: '_minecraft',
		srvProto: '_tcp',
		label: 'Minecraft (Java Edition)',
		hint: 'TCP via Playit. Auto-creates an SRV record on your zone so vanilla clients can connect with just the hostname.',
	},
	minecraft_bedrock: {
		protocol: 'udp',
		provider: 'playit',
		defaultPort: 19132,
		defaultHost: '192.168.1.50',
		requiresZone: false,
		showScheme: false,
		showPath: false,
		label: 'Minecraft (Bedrock Edition)',
		hint: 'UDP via Playit. Bedrock cannot read SRV — players must enter the assigned host:port directly. CloudGate shows the exact string to copy after deploy.',
	},
	raw_tcp: {
		protocol: 'tcp',
		provider: 'playit',
		defaultPort: 22,
		defaultHost: '192.168.1.50',
		requiresZone: false,
		showScheme: false,
		showPath: false,
		label: 'Raw TCP service',
		hint: 'Any TCP service (SSH, custom game server, etc.) tunneled via Playit.',
	},
	raw_udp: {
		protocol: 'udp',
		provider: 'playit',
		defaultPort: 27015,
		defaultHost: '192.168.1.50',
		requiresZone: false,
		showScheme: false,
		showPath: false,
		label: 'Raw UDP service',
		hint: 'Any UDP service tunneled via Playit.',
	},
};

export function HostFormPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const accounts = useCloudflareAccounts();
	const tunnels = useTunnels();
	const create = useCreateHost();

	const [hostType, setHostType] = useState<HostType>('web');
	const spec = HOST_TYPES[hostType];

	const form = useForm({
		initialValues: {
			tunnel_id: '' as string,
			cf_zone_id: '' as string,
			hostname: '',
			forward_scheme: 'http' as 'http' | 'https',
			forward_host: spec.defaultHost,
			forward_port: spec.defaultPort,
			path_prefix: '/',
			no_tls_verify: false,
		},
		validate: {
			hostname: (v) => (HOSTNAME_RX.test(v) ? null : t('hosts.invalid_hostname')),
			forward_host: (v) => (v.length > 0 ? null : t('hosts.required')),
			forward_port: (v) => (v >= 1 && v <= 65535 ? null : t('hosts.invalid_port')),
			tunnel_id: (v) => (!v ? t('hosts.tunnel_required') : null),
			cf_zone_id: (v) => (spec.requiresZone && !v ? t('hosts.zone_required') : null),
		},
	});

	// Tunnels filtered to the provider this host type needs.
	const eligibleTunnels = useMemo(() => {
		return (tunnels.data?.tunnels ?? []).filter((t) => t.provider === spec.provider);
	}, [tunnels.data, spec.provider]);

	const tunnelId = form.values.tunnel_id ? Number.parseInt(form.values.tunnel_id, 10) : null;
	const selectedTunnel = eligibleTunnels.find((t) => t.id === tunnelId);
	const zonesAccountId = selectedTunnel?.cloudflare_account_id ?? null;
	const zones = useZones(zonesAccountId);

	const onTypeChange = (newType: HostType): void => {
		const newSpec = HOST_TYPES[newType];
		setHostType(newType);
		form.setValues({
			tunnel_id: '',
			cf_zone_id: '',
			forward_scheme: newSpec.protocol === 'https' ? 'https' : 'http',
			forward_host: newSpec.defaultHost,
			forward_port: newSpec.defaultPort,
			path_prefix: '/',
			no_tls_verify: false,
		});
	};

	const [submitting, setSubmitting] = useState(false);

	const onSubmit = form.onSubmit(async (values) => {
		setSubmitting(true);
		try {
			const payload: CreateHostInput = {
				mode: 'cloudflare_tunnel',
				protocol: spec.protocol,
				hostname: values.hostname.toLowerCase(),
				forward_scheme: spec.showScheme ? values.forward_scheme : 'http',
				forward_host: values.forward_host,
				forward_port: values.forward_port,
				path_prefix: spec.showPath ? values.path_prefix || '/' : '/',
				tunnel_id: values.tunnel_id ? Number.parseInt(values.tunnel_id, 10) : undefined,
				cf_zone_id: values.cf_zone_id ? Number.parseInt(values.cf_zone_id, 10) : undefined,
				tls_options:
					spec.showScheme && values.forward_scheme === 'https' ? { no_tls_verify: values.no_tls_verify } : {},
			};
			await create.mutateAsync(payload);
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('hosts.created_title'),
				message: t('hosts.created_message', { hostname: values.hostname }),
			});
			navigate('/hosts');
		} catch {
			/* surfaced below */
		} finally {
			setSubmitting(false);
		}
	});

	const createError =
		create.error instanceof ApiError
			? `${create.error.message} (${create.error.code})`
			: create.error
				? t('login.unknown_error')
				: null;

	const showNoTunnelHint = eligibleTunnels.length === 0;

	return (
		<Stack>
			<Title order={2}>{t('hosts.new_title')}</Title>
			<Card withBorder>
				<form onSubmit={onSubmit}>
					<Stack>
						{createError && (
							<Alert color="red" icon={<IconAlertCircle size={18} />}>
								{createError}
							</Alert>
						)}
						{accounts.data?.accounts.length === 0 && spec.provider === 'cloudflared' && (
							<Alert color="orange">{t('hosts.no_cf_warning')}</Alert>
						)}

						<Select
							label="What are you hosting?"
							description="Picks the right tunnel provider and port for the job."
							value={hostType}
							onChange={(v) => v && onTypeChange(v as HostType)}
							data={[
								{ value: 'web', label: HOST_TYPES.web.label },
								{ value: 'minecraft_java', label: HOST_TYPES.minecraft_java.label },
								{ value: 'minecraft_bedrock', label: HOST_TYPES.minecraft_bedrock.label },
								{ value: 'raw_tcp', label: HOST_TYPES.raw_tcp.label },
								{ value: 'raw_udp', label: HOST_TYPES.raw_udp.label },
							]}
						/>

						<Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
							<Text size="sm">{spec.hint}</Text>
							<Group gap={6} mt={6}>
								<Badge size="xs" variant="light">
									protocol: {spec.protocol}
								</Badge>
								<Badge size="xs" variant="light">
									provider: {spec.provider}
								</Badge>
								{spec.srvService && (
									<Badge size="xs" variant="light" color="grape">
										SRV: {spec.srvService}.{spec.srvProto}
									</Badge>
								)}
							</Group>
						</Alert>

						{hostType === 'minecraft_bedrock' && (
							<Alert color="yellow" icon={<IconAlertCircle size={18} />} title="Bedrock has no SRV support">
								Players will need the exact <strong>host:port</strong> CloudGate shows after deploy (e.g.{' '}
								<code>mc-abc.joinmc.link:54322</code>) — type it into the Bedrock client's Servers tab. The
								hostname alone won't resolve.
							</Alert>
						)}

						{showNoTunnelHint && spec.provider === 'cloudflared' && (
							<Alert color="orange">{t('hosts.no_tunnel_warning')}</Alert>
						)}
						{showNoTunnelHint && spec.provider === 'playit' && (
							<Alert color="orange">
								No Playit tunnel found. Add a Playit account in Settings → Playit, then create a Playit tunnel
								on the Tunnels page.
							</Alert>
						)}

						<Select
							label="Tunnel"
							placeholder={t('hosts.pick_tunnel')}
							data={eligibleTunnels.map((tn) => ({ value: String(tn.id), label: tn.name }))}
							{...form.getInputProps('tunnel_id')}
						/>

						{spec.requiresZone && (
							<Select
								label="DNS zone"
								placeholder={t('hosts.pick_zone')}
								disabled={!tunnelId || !zonesAccountId}
								description={
									spec.provider === 'playit'
										? 'Where to publish the SRV record so players can connect with the hostname.'
										: undefined
								}
								data={zones.data?.zones.map((z) => ({ value: String(z.id), label: z.name })) ?? []}
								{...form.getInputProps('cf_zone_id')}
							/>
						)}

						<TextInput
							label={t('hosts.hostname_field')}
							placeholder={
								spec.protocol === 'tcp' || spec.protocol === 'udp' ? 'play.example.com' : 'immich.example.com'
							}
							{...form.getInputProps('hostname')}
							required
						/>

						<Group grow>
							{spec.showScheme && (
								<Select
									label={t('hosts.scheme_field')}
									data={[
										{ value: 'http', label: 'http' },
										{ value: 'https', label: 'https' },
									]}
									{...form.getInputProps('forward_scheme')}
								/>
							)}
							<TextInput
								label={t('hosts.forward_host_field')}
								placeholder={spec.defaultHost}
								{...form.getInputProps('forward_host')}
								required
							/>
							<NumberInput
								label={t('hosts.forward_port_field')}
								min={1}
								max={65535}
								{...form.getInputProps('forward_port')}
								required
							/>
						</Group>

						{spec.showPath && (
							<TextInput
								label="Path prefix"
								description="Use '/' to route the whole hostname; restrict here to share a hostname across multiple paths."
								{...form.getInputProps('path_prefix')}
							/>
						)}

						{spec.showScheme && form.values.forward_scheme === 'https' && (
							<Checkbox
								label={t('hosts.no_tls_verify_label')}
								description={t('hosts.no_tls_verify_hint')}
								{...form.getInputProps('no_tls_verify', { type: 'checkbox' })}
							/>
						)}

						<Group justify="flex-end">
							<Button variant="default" onClick={() => navigate('/hosts')}>
								{t('common.cancel')}
							</Button>
							<Button type="submit" loading={submitting}>
								{t('hosts.create_submit')}
							</Button>
						</Group>
					</Stack>
				</form>
			</Card>
		</Stack>
	);
}
