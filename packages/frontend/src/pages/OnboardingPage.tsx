/**
 * First-time onboarding wizard.
 *
 * Steps:
 *   1. Welcome
 *   2. Add Cloudflare account (links out + paste token)
 *   3. Create tunnel
 *   4. Add first host
 *   5. Done
 *
 * Dashboard checks: if 0 accounts + 0 tunnels + 0 hosts, redirects here on first
 * login. User can dismiss via "skip" → stored in localStorage so it doesn't
 * pester them again on the same browser.
 */

import {
	Alert,
	Anchor,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Loader,
	PasswordInput,
	Select,
	Stack,
	Stepper,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCircleCheck, IconCloudPlus, IconRoute } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
	useAddCloudflareAccount,
	useCloudflareAccounts,
	useZones,
} from '../api/cloudflare.js';
import { useCreateTunnel, useTunnels } from '../api/tunnels.js';

const ONBOARDING_DISMISSED_KEY = 'cloudgate.onboarding_dismissed';

export function dismissOnboarding(): void {
	try {
		localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
	} catch {
		/* ignore */
	}
}

export function wasOnboardingDismissed(): boolean {
	try {
		return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';
	} catch {
		return false;
	}
}

export function OnboardingPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const [active, setActive] = useState(0);

	const accounts = useCloudflareAccounts();
	const tunnels = useTunnels();
	const addAccount = useAddCloudflareAccount();
	const createTunnel = useCreateTunnel();

	// Live progression: once they actually create things, jump them forward
	const hasAccount = (accounts.data?.accounts.length ?? 0) > 0;
	const hasTunnel = (tunnels.data?.tunnels.length ?? 0) > 0;

	const tokenForm = useForm({
		initialValues: { label: 'main', api_token: '' },
		validate: {
			label: (v) => (v.length > 0 ? null : t('hosts.required')),
			api_token: (v) => (v.length >= 20 ? null : t('cloudflare.token_too_short')),
		},
	});

	const tunnelForm = useForm({
		initialValues: { name: 'homelab' },
		validate: {
			name: (v) => (/^[a-zA-Z0-9-_]+$/.test(v) ? null : t('tunnels.invalid_name')),
		},
	});

	const onAddAccount = tokenForm.onSubmit(async (values) => {
		try {
			await addAccount.mutateAsync(values);
			notifications.show({
				color: 'green',
				icon: <IconCheck size={16} />,
				message: t('onboarding.step2_ok'),
			});
			tokenForm.reset();
			setActive(2);
		} catch (err) {
			notifications.show({
				color: 'red',
				message: err instanceof ApiError ? `${err.message} (${err.code})` : (err as Error).message,
			});
		}
	});

	const onCreateTunnel = tunnelForm.onSubmit(async (values) => {
		if (!accounts.data?.accounts[0]) return;
		try {
			await createTunnel.mutateAsync({
				cloudflare_account_id: accounts.data.accounts[0].id,
				name: values.name,
			});
			notifications.show({
				color: 'green',
				icon: <IconCheck size={16} />,
				message: t('onboarding.step3_ok'),
			});
			setActive(3);
		} catch (err) {
			notifications.show({
				color: 'red',
				message: err instanceof ApiError ? `${err.message} (${err.code})` : (err as Error).message,
			});
		}
	});

	const onSkip = () => {
		dismissOnboarding();
		navigate('/');
	};

	const onFinish = () => {
		dismissOnboarding();
		navigate('/');
	};

	return (
		<Stack maw={780} mx="auto" py="xl">
			<Group justify="space-between">
				<Title order={2}>{t('onboarding.title')}</Title>
				<Button variant="subtle" onClick={onSkip}>
					{t('onboarding.skip')}
				</Button>
			</Group>

			<Stepper active={active} onStepClick={setActive} allowNextStepsSelect={false}>
				{/* Step 1: Welcome */}
				<Stepper.Step label={t('onboarding.step1_label')} description={t('onboarding.step1_desc')}>
					<Card withBorder>
						<Stack>
							<Title order={4}>{t('onboarding.welcome_title')}</Title>
							<Text>{t('onboarding.welcome_body')}</Text>
							<Stack gap={4}>
								<Text size="sm">• {t('onboarding.welcome_bullet1')}</Text>
								<Text size="sm">• {t('onboarding.welcome_bullet2')}</Text>
								<Text size="sm">• {t('onboarding.welcome_bullet3')}</Text>
							</Stack>
							<Group>
								<Button onClick={() => setActive(1)}>{t('onboarding.lets_go')}</Button>
							</Group>
						</Stack>
					</Card>
				</Stepper.Step>

				{/* Step 2: Cloudflare token */}
				<Stepper.Step label={t('onboarding.step2_label')} description={t('onboarding.step2_desc')}>
					<Card withBorder>
						<Stack>
							<Title order={4}>
								<IconCloudPlus size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />
								{t('onboarding.step2_title')}
							</Title>
							<Text size="sm">{t('onboarding.step2_intro')}</Text>
							<Alert color="blue">
								<Stack gap={4}>
									<Text size="sm">1. {t('onboarding.cf_step1')}</Text>
									<Text size="sm">
										2. {t('onboarding.cf_step2')} — <Code>Account · Cloudflare Tunnel · Edit</Code>
									</Text>
									<Text size="sm">
										3. {t('onboarding.cf_step3')} — <Code>Zone · DNS · Edit</Code>
									</Text>
									<Text size="sm">
										4. {t('onboarding.cf_step4')} — <Code>Zone · Zone · Read</Code>
									</Text>
									<Text size="sm">
										5.{' '}
										<Anchor
											href="https://dash.cloudflare.com/profile/api-tokens"
											target="_blank"
											rel="noreferrer"
										>
											{t('onboarding.cf_open_dashboard')} ↗
										</Anchor>
									</Text>
								</Stack>
							</Alert>
							{hasAccount ? (
								<Alert color="green" icon={<IconCircleCheck size={16} />}>
									{t('onboarding.step2_already_have')}
								</Alert>
							) : (
								<form onSubmit={onAddAccount}>
									<Stack>
										<TextInput
											label={t('cloudflare.label_field')}
											placeholder="main"
											{...tokenForm.getInputProps('label')}
											required
										/>
										<PasswordInput
											label={t('cloudflare.token_field')}
											placeholder="cf-..."
											{...tokenForm.getInputProps('api_token')}
											required
										/>
										<Group>
											<Button type="submit" loading={addAccount.isPending}>
												{t('cloudflare.validate_and_add')}
											</Button>
										</Group>
									</Stack>
								</form>
							)}
							{hasAccount && (
								<Group>
									<Button onClick={() => setActive(2)}>{t('onboarding.next')}</Button>
								</Group>
							)}
						</Stack>
					</Card>
				</Stepper.Step>

				{/* Step 3: Tunnel */}
				<Stepper.Step label={t('onboarding.step3_label')} description={t('onboarding.step3_desc')}>
					<Card withBorder>
						<Stack>
							<Title order={4}>
								<IconRoute size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />
								{t('onboarding.step3_title')}
							</Title>
							<Text size="sm">{t('onboarding.step3_intro')}</Text>
							{!hasAccount ? (
								<Alert color="orange">{t('onboarding.need_account_first')}</Alert>
							) : hasTunnel ? (
								<Alert color="green" icon={<IconCircleCheck size={16} />}>
									{t('onboarding.step3_already_have')}
								</Alert>
							) : (
								<form onSubmit={onCreateTunnel}>
									<Stack>
										<TextInput
											label={t('tunnels.name_field')}
											placeholder="homelab"
											description={t('tunnels.name_hint')}
											{...tunnelForm.getInputProps('name')}
											required
										/>
										<Group>
											<Button type="submit" loading={createTunnel.isPending}>
												{t('tunnels.submit')}
											</Button>
										</Group>
									</Stack>
								</form>
							)}
							{hasTunnel && (
								<Group>
									<Button onClick={() => setActive(3)}>{t('onboarding.next')}</Button>
								</Group>
							)}
						</Stack>
					</Card>
				</Stepper.Step>

				{/* Step 4: First host */}
				<Stepper.Step label={t('onboarding.step4_label')} description={t('onboarding.step4_desc')}>
					<Card withBorder>
						<Stack>
							<Title order={4}>{t('onboarding.step4_title')}</Title>
							<Text size="sm">{t('onboarding.step4_intro')}</Text>
							<Group>
								<Button component={Link} to="/hosts/new" variant="filled">
									{t('hosts.add')}
								</Button>
								<Button variant="default" onClick={() => setActive(4)}>
									{t('onboarding.next')}
								</Button>
							</Group>
						</Stack>
					</Card>
				</Stepper.Step>

				{/* Step 5: Done */}
				<Stepper.Completed>
					<Card withBorder>
						<Stack>
							<Group>
								<IconCheck size={28} color="#51cf66" />
								<Title order={4}>{t('onboarding.done_title')}</Title>
							</Group>
							<Text>{t('onboarding.done_body')}</Text>
							<Stack gap={4}>
								<Text size="sm">
									<Badge mr="xs">{t('nav.dashboard')}</Badge> {t('onboarding.done_hint_dashboard')}
								</Text>
								<Text size="sm">
									<Badge mr="xs">{t('nav.settings')}</Badge> {t('onboarding.done_hint_settings')}
								</Text>
								<Text size="sm">
									<Badge mr="xs">{t('nav.updates')}</Badge> {t('onboarding.done_hint_updates')}
								</Text>
							</Stack>
							<Group>
								<Button onClick={onFinish}>{t('onboarding.finish')}</Button>
							</Group>
						</Stack>
					</Card>
				</Stepper.Completed>
			</Stepper>
		</Stack>
	);
}

// Touch unused-but-relevant imports to keep TS happy in strict mode
void Loader;
void Select;
void useZones;
