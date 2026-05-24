/**
 * Edit a host's forwarding settings without delete+recreate.
 *
 * Only mutable fields: forward_scheme, forward_host, forward_port,
 * tls_options.no_tls_verify, path_prefix. The hostname/zone/tunnel are
 * deliberately read-only — changing those would require recreating the
 * DNS record, which is fragile and rare.
 *
 * Mantine modal with a small form. The "Save" button calls PUT
 * /api/hosts/:id which also re-runs deployHost() → upstream probe.
 */

import {
	Alert,
	Anchor,
	Box,
	Button,
	Checkbox,
	Collapse,
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
import { IconBulb, IconCheck, IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { type HostDto, useUpdateHost } from '../api/hosts.js';

interface EditHostModalProps {
	host: HostDto | null;
	opened: boolean;
	onClose: () => void;
}

export function EditHostModal({ host, opened, onClose }: EditHostModalProps) {
	const { t } = useTranslation();
	const update = useUpdateHost();
	const [advancedOpen, advanced] = useDisclosure(false);
	const form = useForm({
		initialValues: {
			forward_scheme: 'http' as 'http' | 'https',
			forward_host: '',
			forward_port: 80,
			path_prefix: '/',
			no_tls_verify: false,
			http_host_header: '',
			origin_server_name: '',
			no_happy_eyeballs: false,
			http2_origin: false,
			disable_chunked_encoding: false,
			connect_timeout_seconds: 30,
		},
	});

	useEffect(() => {
		if (!host) return;
		const adv = host.advanced_options ?? {};
		form.setValues({
			forward_scheme: host.forward_scheme,
			forward_host: host.forward_host,
			forward_port: host.forward_port,
			path_prefix: host.path_prefix,
			no_tls_verify: Boolean(host.tls_options?.no_tls_verify),
			http_host_header: adv.http_host_header ?? '',
			origin_server_name: adv.origin_server_name ?? '',
			no_happy_eyeballs: Boolean(adv.no_happy_eyeballs),
			http2_origin: Boolean(adv.http2_origin),
			disable_chunked_encoding: Boolean(adv.disable_chunked_encoding),
			connect_timeout_seconds: adv.connect_timeout_seconds ?? 30,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host?.id]);

	const onSubmit = form.onSubmit(async (values) => {
		if (!host) return;
		try {
			// Only persist non-default advanced options. Empty strings → undefined
			// so the JSON blob stays compact and the cloudflared template doesn't
			// emit empty originRequest fields.
			const advanced_options = {
				...(values.http_host_header ? { http_host_header: values.http_host_header } : {}),
				...(values.origin_server_name ? { origin_server_name: values.origin_server_name } : {}),
				...(values.no_happy_eyeballs ? { no_happy_eyeballs: true } : {}),
				...(values.http2_origin ? { http2_origin: true } : {}),
				...(values.disable_chunked_encoding ? { disable_chunked_encoding: true } : {}),
				...(values.connect_timeout_seconds && values.connect_timeout_seconds !== 30
					? { connect_timeout_seconds: values.connect_timeout_seconds }
					: {}),
			};
			await update.mutateAsync({
				id: host.id,
				input: {
					forward_scheme: values.forward_scheme,
					forward_host: values.forward_host,
					forward_port: values.forward_port,
					path_prefix: values.path_prefix,
					tls_options: { no_tls_verify: values.no_tls_verify },
					advanced_options,
				},
			});
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
						Advanced (originRequest)
					</Button>
					<Collapse in={advancedOpen}>
						<Stack gap="sm">
							<Alert color="blue" variant="light">
								<Text size="xs">
									HomeAssistant returning <strong>400 Bad Request</strong>? Set <code>http_host_header</code>{' '}
									to <code>homeassistant.local:8123</code> (or your LAN IP + port) so HA recognises the
									proxied Host header. You may also need <code>trusted_proxies: [127.0.0.1]</code> in HA's{' '}
									<code>configuration.yaml</code>.
								</Text>
							</Alert>
							<TextInput
								label="HTTP Host header override"
								description="Sent to origin in the Host header. Useful for apps that check trusted_proxies."
								placeholder="homeassistant.local:8123"
								{...form.getInputProps('http_host_header')}
							/>
							<TextInput
								label="Origin server name (SNI)"
								description="Set SNI when forwarding to HTTPS with a cert that doesn't match the IP."
								placeholder="my-app.local"
								{...form.getInputProps('origin_server_name')}
							/>
							<Group grow>
								<Checkbox
									label="HTTP/2 to origin"
									description="Force HTTP/2 — speeds up apps that support it."
									{...form.getInputProps('http2_origin', { type: 'checkbox' })}
								/>
								<Checkbox
									label="No Happy Eyeballs"
									description="Disable IPv6 fallback — set if your origin is IPv4-only."
									{...form.getInputProps('no_happy_eyeballs', { type: 'checkbox' })}
								/>
							</Group>
							<Checkbox
								label="Disable chunked encoding"
								description="Needed for some old HTTP/1.0 origins that mishandle Transfer-Encoding: chunked."
								{...form.getInputProps('disable_chunked_encoding', { type: 'checkbox' })}
							/>
							<NumberInput
								label="Connect timeout (seconds)"
								description="TCP connect timeout to origin. Default 30s."
								min={1}
								max={600}
								{...form.getInputProps('connect_timeout_seconds')}
							/>
							<Text size="xs" c="dimmed">
								Full list of options:{' '}
								<Anchor
									href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/cloudflared-parameters/origin-parameters/"
									target="_blank"
								>
									cloudflared origin parameters
								</Anchor>
							</Text>
						</Stack>
					</Collapse>

					<Box>
						<Button type="submit" loading={update.isPending}>
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
