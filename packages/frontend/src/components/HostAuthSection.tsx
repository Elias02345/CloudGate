/**
 * Visitor-login settings for one host (issue #99), shown inside EditHostModal.
 * Talks to /api/hosts/:id/auth; the backend routes the host through its
 * built-in auth gateway when credentials exist.
 */

import { Alert, Badge, Button, Group, Image, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	type TotpSetup,
	useHostAuth,
	useRemoveHostAuth,
	useSaveHostAuth,
	useTotpSetup,
} from '../api/host-auth.js';
import type { HostDto } from '../api/hosts.js';

export function HostAuthSection({ host }: { host: HostDto }) {
	const { t } = useTranslation();
	const supported =
		host.mode === 'cloudflare_tunnel' && (host.protocol === 'http' || host.protocol === 'https');
	const state = useHostAuth(host.id, supported);
	const save = useSaveHostAuth(host.id);
	const remove = useRemoveHostAuth(host.id);
	const setup = useTotpSetup(host.id);

	const current = state.data;
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [pending, setPending] = useState<TotpSetup | null>(null);
	const [code, setCode] = useState('');

	useEffect(() => {
		setUsername(current?.enabled ? current.username : '');
		setPassword('');
		setPending(null);
		setCode('');
	}, [current]);

	if (!supported) {
		return (
			<Text size="xs" c="dimmed">
				{t('host_auth.unsupported')}
			</Text>
		);
	}

	const enabled = Boolean(current?.enabled);
	const totpOn = current?.enabled === true && current.totp_enabled;

	const onResult = (deployError: string | null, okKey: string) => {
		if (deployError) {
			notifications.show({
				color: 'yellow',
				message: t('host_auth.deploy_warning', { error: deployError }),
			});
		} else {
			notifications.show({ color: 'green', message: t(okKey) });
		}
	};
	const onError = (err: unknown) =>
		notifications.show({ color: 'red', message: err instanceof Error ? err.message : String(err) });

	const submit = (totp?: { secret: string; code: string } | null) =>
		save.mutate(
			{ username, ...(password ? { password } : {}), ...(totp !== undefined ? { totp } : {}) },
			{ onSuccess: (r) => onResult(r.deploy_error, 'host_auth.saved'), onError }
		);

	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Text fw={600}>{t('host_auth.title')}</Text>
				<Badge color={enabled ? 'green' : 'gray'} variant="light">
					{enabled ? t('host_auth.status_on') : t('host_auth.status_off')}
				</Badge>
			</Group>
			<Text size="xs" c="dimmed">
				{t('host_auth.hint')}
			</Text>

			<TextInput
				label={t('host_auth.username')}
				value={username}
				onChange={(e) => setUsername(e.currentTarget.value)}
				autoComplete="off"
			/>
			<PasswordInput
				label={t('host_auth.password')}
				description={enabled ? t('host_auth.password_new_hint') : t('host_auth.password_hint')}
				value={password}
				onChange={(e) => setPassword(e.currentTarget.value)}
				autoComplete="new-password"
			/>

			{enabled &&
				(totpOn ? (
					<Group justify="space-between">
						<Text size="sm">{t('host_auth.totp_enabled')}</Text>
						<Button
							size="xs"
							variant="subtle"
							color="red"
							disabled={username.length < 3}
							onClick={() => submit(null)}
						>
							{t('host_auth.totp_remove')}
						</Button>
					</Group>
				) : pending ? (
					<Alert variant="light">
						<Stack gap="xs" align="flex-start">
							<Text size="sm">{t('host_auth.totp_scan')}</Text>
							<Image src={pending.qr_code_data_url} w={180} h={180} alt="" />
							<Text size="xs" ff="monospace">
								{pending.secret}
							</Text>
							<Group align="flex-end">
								<TextInput
									label={t('host_auth.totp_code')}
									value={code}
									onChange={(e) => setCode(e.currentTarget.value)}
									inputMode="numeric"
									maxLength={6}
									w={120}
								/>
								<Button
									disabled={!/^\d{6}$/.test(code) || username.length < 3}
									loading={save.isPending}
									onClick={() => submit({ secret: pending.secret, code })}
								>
									{t('host_auth.save')}
								</Button>
							</Group>
						</Stack>
					</Alert>
				) : (
					<Button
						size="xs"
						variant="light"
						style={{ alignSelf: 'flex-start' }}
						loading={setup.isPending}
						onClick={() => setup.mutate(undefined, { onSuccess: setPending, onError })}
					>
						{t('host_auth.totp_setup')}
					</Button>
				))}

			<Group>
				<Button
					loading={save.isPending && !pending}
					disabled={username.length < 3 || (!enabled && password.length < 12)}
					onClick={() => submit()}
				>
					{enabled ? t('host_auth.save') : t('host_auth.enable')}
				</Button>
				{enabled && (
					<Button
						variant="subtle"
						color="red"
						loading={remove.isPending}
						onClick={() =>
							remove.mutate(undefined, {
								onSuccess: (r) => onResult(r.deploy_error, 'host_auth.removed'),
								onError,
							})
						}
					>
						{t('host_auth.remove')}
					</Button>
				)}
			</Group>
		</Stack>
	);
}
