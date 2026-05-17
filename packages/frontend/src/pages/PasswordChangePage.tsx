import { Alert, Button, Card, Divider, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconShieldLock, IconUserPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useChangePassword, useMe } from '../api/auth.js';
import { ApiError } from '../api/client.js';

export function PasswordChangePage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { data: me } = useMe();
	const change = useChangePassword();

	const firstLogin = me?.user?.must_change_password ?? false;

	const form = useForm({
		initialValues: {
			current_password: '',
			new_password: '',
			confirm: '',
			email: me?.user?.email ?? '',
			name: me?.user?.name ?? 'Admin',
		},
		validate: {
			current_password: (v) => (v.length >= 1 ? null : t('password.current_required')),
			new_password: (v) => (v.length >= 12 ? null : t('password.too_short')),
			confirm: (v, values) => (v === values.new_password ? null : t('password.mismatch')),
			email: (v) =>
				firstLogin && v ? (/^\S+@\S+\.\S+$/.test(v) ? null : t('login.invalid_email')) : null,
			name: (v) => (firstLogin ? (v.trim().length >= 1 ? null : t('password.name_required')) : null),
		},
	});

	const onSubmit = form.onSubmit(async (values) => {
		try {
			await change.mutateAsync({
				current_password: values.current_password,
				new_password: values.new_password,
				...(firstLogin && values.email && values.email !== me?.user?.email ? { email: values.email } : {}),
				...(firstLogin && values.name ? { name: values.name } : {}),
			});
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t(firstLogin ? 'password.first_setup_done_title' : 'password.success_title'),
				message: t(firstLogin ? 'password.first_setup_done_message' : 'password.success_message'),
			});
			navigate(firstLogin ? '/onboarding' : '/', { replace: true });
		} catch {
			/* surfaced via change.error */
		}
	});

	const errMessage =
		change.error instanceof ApiError
			? change.error.code === 'AUTH_FAILED'
				? t('password.current_wrong')
				: change.error.code === 'CONFLICT'
					? t('password.email_taken')
					: change.error.message
			: change.error
				? t('login.unknown_error')
				: null;

	return (
		<Stack align="center" mt="xl">
			<Card shadow="sm" radius="md" withBorder w={520}>
				<Stack>
					<Title order={3}>
						{firstLogin ? (
							<>
								<IconUserPlus size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />
								{t('password.first_setup_title')}
							</>
						) : (
							<>
								<IconShieldLock size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />
								{t('password.title')}
							</>
						)}
					</Title>
					{firstLogin && (
						<Alert color="cg-orange" title={t('password.first_setup_alert_title')}>
							{t('password.first_setup_alert_body')}
						</Alert>
					)}
					<Text size="sm" c="dimmed">
						{t('password.hint')}
					</Text>
					{errMessage && <Alert color="red">{errMessage}</Alert>}
					<form onSubmit={onSubmit}>
						<Stack>
							{firstLogin && (
								<>
									<TextInput
										label={t('password.account_email')}
										description={t('password.account_email_hint')}
										placeholder="you@example.com"
										{...form.getInputProps('email')}
										autoComplete="email"
										required
									/>
									<TextInput
										label={t('password.account_name')}
										placeholder="Elias"
										{...form.getInputProps('name')}
										autoComplete="name"
										required
									/>
									<Divider label={t('password.divider_password')} labelPosition="center" />
								</>
							)}
							<PasswordInput
								label={firstLogin ? t('password.initial_password') : t('password.current')}
								description={firstLogin ? t('password.initial_password_hint') : undefined}
								{...form.getInputProps('current_password')}
								autoComplete="current-password"
								required
							/>
							<PasswordInput
								label={t('password.new')}
								{...form.getInputProps('new_password')}
								autoComplete="new-password"
								required
							/>
							<PasswordInput
								label={t('password.confirm')}
								{...form.getInputProps('confirm')}
								autoComplete="new-password"
								required
							/>
							<Button type="submit" fullWidth loading={change.isPending}>
								{firstLogin ? t('password.first_setup_submit') : t('password.submit')}
							</Button>
						</Stack>
					</form>
				</Stack>
			</Card>
		</Stack>
	);
}
