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
import { IconAlertCircle, IconClock, IconUserPlus } from '@tabler/icons-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useMe } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useSetup, useSetupStatus } from '../api/setup.js';

/**
 * First-run admin setup — the one screen a fresh install shows before
 * anything else. Styled like LoginPage/PasswordChangePage: same Card,
 * same layout, no new components.
 */
export function SetupPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { data: me } = useMe();
	const status = useSetupStatus();
	const setup = useSetup();

	// Setup already done (someone else finished it, or we're re-visiting
	// after a restart) — leave for login/home instead of showing the form.
	useEffect(() => {
		if (status.data && !status.data.needs_setup) {
			navigate(me?.user ? '/' : '/login', { replace: true });
		}
	}, [status.data, me, navigate]);

	const form = useForm({
		initialValues: { name: '', email: '', password: '', confirm: '' },
		validate: {
			name: (v) => (v.trim().length >= 1 ? null : t('setup.name_required')),
			email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t('login.invalid_email')),
			password: (v) => (v.length >= 12 ? null : t('password.too_short')),
			confirm: (v, values) => (v === values.password ? null : t('password.mismatch')),
		},
	});

	const onSubmit = form.onSubmit(async (values) => {
		try {
			await setup.mutateAsync({ name: values.name, email: values.email, password: values.password });
			navigate('/onboarding', { replace: true });
		} catch {
			/* error surfaced via setup.error below */
		}
	});

	const windowClosed = Boolean(status.data?.needs_setup && status.data.window_open === false);

	const errCode = setup.error instanceof ApiError ? setup.error.code : null;
	const errMessage =
		setup.error instanceof ApiError
			? errCode === 'SETUP_NOT_LOCAL'
				? t('setup.error_not_local')
				: errCode === 'SETUP_WINDOW_CLOSED'
					? t('setup.error_window_closed')
					: errCode === 'SETUP_DONE'
						? t('setup.error_already_done')
						: setup.error.message
			: setup.error
				? t('login.unknown_error')
				: null;

	const formDisabled = windowClosed || errCode === 'SETUP_WINDOW_CLOSED';

	return (
		<Center mih="calc(100dvh - 2 * var(--app-shell-header-offset, 56px) - 2 * var(--mantine-spacing-md))">
			<Card shadow="sm" radius="md" withBorder w="100%" maw={440}>
				<Stack>
					<Title order={3} ta="center">
						<IconUserPlus size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />
						{t('setup.title')}
					</Title>
					<Text size="sm" c="dimmed" ta="center">
						{t('setup.intro')}
					</Text>

					{windowClosed && (
						<Alert color="cg-orange" icon={<IconClock size={18} />} title={t('setup.window_closed_title')}>
							{t('setup.window_closed_body')}
						</Alert>
					)}
					{errMessage && (
						<Alert color="red" icon={<IconAlertCircle size={18} />} title={t('setup.failed')}>
							{errMessage}
						</Alert>
					)}

					<form onSubmit={onSubmit}>
						<Stack>
							<TextInput
								label={t('password.account_name')}
								placeholder="Elias"
								{...form.getInputProps('name')}
								autoComplete="name"
								required
								disabled={formDisabled}
							/>
							<TextInput
								label={t('login.email')}
								placeholder="you@example.com"
								{...form.getInputProps('email')}
								autoComplete="email"
								required
								disabled={formDisabled}
							/>
							<PasswordInput
								label={t('password.new')}
								description={t('password.hint')}
								{...form.getInputProps('password')}
								autoComplete="new-password"
								required
								disabled={formDisabled}
							/>
							<PasswordInput
								label={t('password.confirm')}
								{...form.getInputProps('confirm')}
								autoComplete="new-password"
								required
								disabled={formDisabled}
							/>
							<Button type="submit" fullWidth loading={setup.isPending} disabled={formDisabled}>
								{t('setup.submit')}
							</Button>
						</Stack>
					</form>

					<Text size="xs" c="dimmed" ta="center">
						<Anchor component={Link} to="/restore">
							{t('setup.restore_link')}
						</Anchor>
					</Text>
				</Stack>
			</Card>
		</Center>
	);
}
