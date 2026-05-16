import { Alert, Button, Card, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconShieldLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useChangePassword, useMe } from '../api/auth.js';
import { ApiError } from '../api/client.js';

export function PasswordChangePage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { data: me } = useMe();
	const change = useChangePassword();

	const form = useForm({
		initialValues: { current_password: '', new_password: '', confirm: '' },
		validate: {
			current_password: (v) => (v.length >= 1 ? null : t('password.current_required')),
			new_password: (v) => (v.length >= 12 ? null : t('password.too_short')),
			confirm: (v, values) => (v === values.new_password ? null : t('password.mismatch')),
		},
	});

	const onSubmit = form.onSubmit(async (values) => {
		try {
			await change.mutateAsync({
				current_password: values.current_password,
				new_password: values.new_password,
			});
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				title: t('password.success_title'),
				message: t('password.success_message'),
			});
			navigate('/', { replace: true });
		} catch {
			/* surfaced via change.error */
		}
	});

	const errMessage =
		change.error instanceof ApiError
			? change.error.code === 'AUTH_FAILED'
				? t('password.current_wrong')
				: change.error.message
			: change.error
				? t('login.unknown_error')
				: null;

	return (
		<Stack align="center" mt="xl">
			<Card shadow="sm" radius="md" withBorder w={480}>
				<Stack>
					<Title order={3}>
						<IconShieldLock size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />
						{t('password.title')}
					</Title>
					{me?.user?.must_change_password && (
						<Alert color="orange" title={t('password.force_title')}>
							{t('password.force_message')}
						</Alert>
					)}
					<Text size="sm" c="dimmed">
						{t('password.hint')}
					</Text>
					{errMessage && <Alert color="red">{errMessage}</Alert>}
					<form onSubmit={onSubmit}>
						<Stack>
							<PasswordInput
								label={t('password.current')}
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
								{t('password.submit')}
							</Button>
						</Stack>
					</form>
				</Stack>
			</Card>
		</Stack>
	);
}
