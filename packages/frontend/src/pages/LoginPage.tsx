import { Alert, Button, Card, PasswordInput, Stack, TextInput, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle } from '@tabler/icons-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLogin, useMe } from '../api/auth.js';
import { ApiError } from '../api/client.js';

export function LoginPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const { data: me } = useMe();
	const login = useLogin();

	// If already logged in, hop straight to the destination.
	useEffect(() => {
		if (me?.user) {
			const dest = me.user.must_change_password ? '/password' : (location.state as { from?: string })?.from ?? '/';
			navigate(dest, { replace: true });
		}
	}, [me, navigate, location.state]);

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
			const dest = result.must_change_password ? '/password' : (location.state as { from?: string })?.from ?? '/';
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
		<Stack align="center" mt="xl">
			<Card shadow="sm" radius="md" withBorder w={400}>
				<Stack>
					<Title order={3}>{t('login.title')}</Title>
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
				</Stack>
			</Card>
		</Stack>
	);
}
