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
	Box,
	Button,
	Checkbox,
	Group,
	Modal,
	NumberInput,
	Select,
	Stack,
	Text,
	TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBulb, IconCheck } from '@tabler/icons-react';
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
	const form = useForm({
		initialValues: {
			forward_scheme: 'http' as 'http' | 'https',
			forward_host: '',
			forward_port: 80,
			path_prefix: '/',
			no_tls_verify: false,
		},
	});

	useEffect(() => {
		if (!host) return;
		form.setValues({
			forward_scheme: host.forward_scheme,
			forward_host: host.forward_host,
			forward_port: host.forward_port,
			path_prefix: host.path_prefix,
			no_tls_verify: Boolean(host.tls_options?.no_tls_verify),
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host?.id]);

	const onSubmit = form.onSubmit(async (values) => {
		if (!host) return;
		try {
			await update.mutateAsync({
				id: host.id,
				input: {
					forward_scheme: values.forward_scheme,
					forward_host: values.forward_host,
					forward_port: values.forward_port,
					path_prefix: values.path_prefix,
					tls_options: { no_tls_verify: values.no_tls_verify },
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
		guessIsHttpsTarget &&
		form.values.forward_scheme === 'http' &&
		host?.last_error?.includes('Wrong scheme');

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
