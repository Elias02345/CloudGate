import { Button, Card, PasswordInput, Stack, TextInput, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

export function LoginPage() {
	const { t } = useTranslation();
	const form = useForm({
		initialValues: { email: '', password: '' },
		validate: {
			email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t('login.invalid_email')),
			password: (v) => (v.length >= 1 ? null : t('login.password_required')),
		},
	});

	return (
		<Stack align="center" mt="xl">
			<Card shadow="sm" radius="md" withBorder w={400}>
				<Stack>
					<Title order={3}>{t('login.title')}</Title>
					<form onSubmit={form.onSubmit((values) => console.log('TODO M1: submit', values))}>
						<Stack>
							<TextInput
								label={t('login.email')}
								placeholder="admin@cloudgate.local"
								{...form.getInputProps('email')}
								autoComplete="username"
							/>
							<PasswordInput
								label={t('login.password')}
								{...form.getInputProps('password')}
								autoComplete="current-password"
							/>
							<Button type="submit" fullWidth>
								{t('login.submit')}
							</Button>
						</Stack>
					</form>
				</Stack>
			</Card>
		</Stack>
	);
}
