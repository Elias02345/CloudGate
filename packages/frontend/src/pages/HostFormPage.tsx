import {
	Alert,
	Button,
	Card,
	Checkbox,
	Group,
	NumberInput,
	Select,
	Stack,
	TextInput,
	Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useCloudflareAccounts, useZones } from '../api/cloudflare.js';
import { ApiError } from '../api/client.js';
import { useCreateHost } from '../api/hosts.js';
import { useTunnels } from '../api/tunnels.js';

const HOSTNAME_RX = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

export function HostFormPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const accounts = useCloudflareAccounts();
	const tunnels = useTunnels();
	const create = useCreateHost();

	const form = useForm({
		initialValues: {
			mode: 'cloudflare_tunnel' as 'cloudflare_tunnel' | 'local_nginx',
			tunnel_id: '' as string,
			cf_zone_id: '' as string,
			hostname: '',
			forward_scheme: 'http' as 'http' | 'https',
			forward_host: '192.168.1.10',
			forward_port: 8080,
			path_prefix: '/',
			no_tls_verify: false,
		},
		validate: {
			hostname: (v) => (HOSTNAME_RX.test(v) ? null : t('hosts.invalid_hostname')),
			forward_host: (v) => (v.length > 0 ? null : t('hosts.required')),
			forward_port: (v) => (v >= 1 && v <= 65535 ? null : t('hosts.invalid_port')),
			tunnel_id: (v, values) =>
				values.mode === 'cloudflare_tunnel' && !v ? t('hosts.tunnel_required') : null,
			cf_zone_id: (v, values) =>
				values.mode === 'cloudflare_tunnel' && !v ? t('hosts.zone_required') : null,
		},
	});

	// Tunnel → derive account → zones list
	const tunnelId = form.values.tunnel_id ? Number.parseInt(form.values.tunnel_id, 10) : null;
	const selectedTunnel = tunnels.data?.tunnels.find((t) => t.id === tunnelId);
	const zonesAccountId = selectedTunnel?.cloudflare_account_id ?? null;
	const zones = useZones(zonesAccountId);

	const [submitting, setSubmitting] = useState(false);

	const onSubmit = form.onSubmit(async (values) => {
		setSubmitting(true);
		try {
			await create.mutateAsync({
				mode: values.mode,
				hostname: values.hostname.toLowerCase(),
				forward_scheme: values.forward_scheme,
				forward_host: values.forward_host,
				forward_port: values.forward_port,
				path_prefix: values.path_prefix || '/',
				tunnel_id: values.tunnel_id ? Number.parseInt(values.tunnel_id, 10) : undefined,
				cf_zone_id: values.cf_zone_id ? Number.parseInt(values.cf_zone_id, 10) : undefined,
				tls_options: { no_tls_verify: values.no_tls_verify },
			});
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
						{accounts.data?.accounts.length === 0 && (
							<Alert color="orange">{t('hosts.no_cf_warning')}</Alert>
						)}
						{tunnels.data?.tunnels.length === 0 && form.values.mode === 'cloudflare_tunnel' && (
							<Alert color="orange">{t('hosts.no_tunnel_warning')}</Alert>
						)}

						<Select
							label={t('hosts.mode_field')}
							data={[
								{ value: 'cloudflare_tunnel', label: t('hosts.mode_tunnel') },
								{ value: 'local_nginx', label: `${t('hosts.mode_nginx')} (M3)`, disabled: true },
							]}
							{...form.getInputProps('mode')}
						/>

						{form.values.mode === 'cloudflare_tunnel' && (
							<>
								<Select
									label={t('hosts.tunnel_field')}
									placeholder={t('hosts.pick_tunnel')}
									data={
										tunnels.data?.tunnels.map((tn) => ({
											value: String(tn.id),
											label: tn.name,
										})) ?? []
									}
									{...form.getInputProps('tunnel_id')}
								/>
								<Select
									label={t('hosts.zone_field')}
									placeholder={t('hosts.pick_zone')}
									disabled={!tunnelId}
									data={
										zones.data?.zones.map((z) => ({
											value: String(z.id),
											label: z.name,
										})) ?? []
									}
									{...form.getInputProps('cf_zone_id')}
								/>
							</>
						)}

						<TextInput
							label={t('hosts.hostname_field')}
							placeholder="immich.example.com"
							{...form.getInputProps('hostname')}
							required
						/>

						<Group grow>
							<Select
								label={t('hosts.scheme_field')}
								data={[
									{ value: 'http', label: 'http' },
									{ value: 'https', label: 'https' },
								]}
								{...form.getInputProps('forward_scheme')}
							/>
							<TextInput
								label={t('hosts.forward_host_field')}
								placeholder="192.168.1.10"
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

						{form.values.forward_scheme === 'https' && (
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
