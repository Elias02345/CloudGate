import {
	Alert,
	Anchor,
	Button,
	Card,
	Center,
	PasswordInput,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle } from '@tabler/icons-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useLogin, useMe } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useRestoreEligibility } from '../api/restore.js';
import { useSetupStatus } from '../api/setup.js';

export function LoginPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const { data: me } = useMe();
	const login = useLogin();
	const eligibility = useRestoreEligibility();
	const setupStatus = useSetupStatus();

	// If already logged in, hop straight to the destination.
	useEffect(() => {
		if (me?.user) {
			const dest = me.user.must_change_password
				? '/password'
				: ((location.state as { from?: string })?.from ?? '/');
			navigate(dest, { replace: true });
		}
	}, [me, navigate, location.state]);

	// No admin exists yet — this install hasn't been set up, so there's
	// nothing to log in with. Send the visitor to /setup instead.
	useEffect(() => {
		if (setupStatus.data?.needs_setup) {
			navigate('/setup', { replace: true });
		}
	}, [setupStatus.data, navigate]);

	const form = useForm({
		initialValues: { email: '', password: '' },
		validate: {
			email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t('login.invalid_email')),
			password: (v) => (v.length >= 1 ? null : t('login.password_required')),
		},
	});

	const onSubmit = form.onSubmit(async (values) => {
		try {
			const result = await login.mutateAsync(values);
			const dest = result.must_change_password
				? '/password'
				: ((location.state as { from?: string })?.from ?? '/');
			navigate(dest, { replace: true });
		} catch {
			/* error surfaced via login.error below */
		}
	});

	const errMessage =
		login.error instanceof ApiError
			? login.error.code === 'AUTH_FAILED'
				? t('login.bad_credentials')
				: login.error.message
			: login.error
				? t('login.unknown_error')
				: null;

	return (
		<Center mih="calc(100dvh - 2 * var(--app-shell-header-offset, 56px) - 2 * var(--mantine-spacing-md))">
			<Card shadow="sm" radius="md" withBorder w="100%" maw={400}>
				<Stack>
					<Title order={3} ta="center">
						{t('login.title')}
					</Title>
					{errMessage && (
						<Alert color="red" icon={<IconAlertCircle size={18} />} title={t('login.failed')}>
							{errMessage}
						</Alert>
					)}
					<form onSubmit={onSubmit}>
						<Stack>
							<TextInput
								label={t('login.email')}
								placeholder="admin@cloudgate.local"
								{...form.getInputProps('email')}
								autoComplete="username"
								required
							/>
							<PasswordInput
								label={t('login.password')}
								{...form.getInputProps('password')}
								autoComplete="current-password"
								required
							/>
							<Button type="submit" fullWidth loading={login.isPending}>
								{t('login.submit')}
							</Button>
						</Stack>
					</form>
					{eligibility.data?.fresh && (
						<Text size="xs" c="dimmed" ta="center">
							{t('login.restore_hint')}{' '}
							<Anchor component={Link} to="/restore">
								{t('login.restore_link')}
							</Anchor>
						</Text>
					)}
				</Stack>
			</Card>
		</Center>
	);
}
