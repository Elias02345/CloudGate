/**
 * First-time onboarding wizard.
 *
 * Animated 6-step flow:
 *   1. Welcome      — pulsing cloud → server arrows
 *   2. Cloudflare   — paste API token
 *   3. Tunnel       — name + create
 *   4. First host   — link to /hosts/new
 *   5. Verification — live /api/health/deep checks
 *   6. Done         — confetti, then auto-start the app tour
 *
 * Persists `onboarding_completed_at` to the backend on finish. Dashboard
 * auto-redirects here when the user has no accounts/tunnels/hosts AND
 * the flag is unset.
 */

import {
	Alert,
	Anchor,
	Badge,
	Button,
	Card,
	Code,
	Group,
	PasswordInput,
	Progress,
	Stack,
	Stepper,
	Text,
	TextInput,
	Title,
	Transition,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
	IconCheck,
	IconCircleCheck,
	IconCloudPlus,
	IconRoute,
	IconShieldCheck,
	IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { usePatchUserFlags } from '../api/auth.js';
import { ApiError, api } from '../api/client.js';
import { useAddCloudflareAccount, useCloudflareAccounts } from '../api/cloudflare.js';
import { useCreateTunnel, useTunnels } from '../api/tunnels.js';
import {
	CloudflareAnim,
	DoneAnim,
	FirstHostAnim,
	TunnelAnim,
	VerifyAnim,
	WelcomeAnim,
} from '../components/onboarding/animations/index.js';

// Kept for the dashboard's existing fallback check on browsers without an
// account yet — we leave the localStorage flag in place for legacy users.
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

interface DeepHealthResponse {
	status: 'ok' | 'degraded';
	checks: Record<string, { ok: boolean; detail?: string; ms?: number }>;
}

const VERIFY_KEYS = ['db', 'secrets', 'cloudflared', 'disk', 'github'] as const;
type VerifyKey = (typeof VERIFY_KEYS)[number];

export function OnboardingPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const [active, setActive] = useState(0);

	const accounts = useCloudflareAccounts();
	const tunnels = useTunnels();
	const addAccount = useAddCloudflareAccount();
	const createTunnel = useCreateTunnel();
	const patchFlags = usePatchUserFlags();

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

	const onFinish = async () => {
		dismissOnboarding();
		try {
			await patchFlags.mutateAsync({ onboarding_completed_at: new Date().toISOString() });
		} catch {
			/* non-blocking — UI will still navigate */
		}
		navigate('/?tour=auto');
	};

	const stepBody = (n: number, body: React.ReactNode) => (
		<Transition mounted={active === n} transition="fade" duration={300} timingFunction="ease">
			{(styles) => <div style={styles}>{body}</div>}
		</Transition>
	);

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
					{stepBody(
						0,
						<Card withBorder>
							<Stack align="center">
								<WelcomeAnim />
								<Title order={4}>{t('onboarding.welcome_title')}</Title>
								<Text ta="center">{t('onboarding.welcome_body')}</Text>
								<Stack gap={4} w="100%">
									<Text size="sm">• {t('onboarding.welcome_bullet1')}</Text>
									<Text size="sm">• {t('onboarding.welcome_bullet2')}</Text>
									<Text size="sm">• {t('onboarding.welcome_bullet3')}</Text>
								</Stack>
								<Group>
									<Button onClick={() => setActive(1)} size="md">
										{t('onboarding.lets_go')}
									</Button>
								</Group>
							</Stack>
						</Card>
					)}
				</Stepper.Step>

				{/* Step 2: Cloudflare token */}
				<Stepper.Step label={t('onboarding.step2_label')} description={t('onboarding.step2_desc')}>
					{stepBody(
						1,
						<Card withBorder>
							<Stack>
								<Group justify="center">
									<CloudflareAnim />
								</Group>
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
					)}
				</Stepper.Step>

				{/* Step 3: Tunnel */}
				<Stepper.Step label={t('onboarding.step3_label')} description={t('onboarding.step3_desc')}>
					{stepBody(
						2,
						<Card withBorder>
							<Stack>
								<Group justify="center">
									<TunnelAnim />
								</Group>
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
					)}
				</Stepper.Step>

				{/* Step 4: First host */}
				<Stepper.Step label={t('onboarding.step4_label')} description={t('onboarding.step4_desc')}>
					{stepBody(
						3,
						<Card withBorder>
							<Stack>
								<Group justify="center">
									<FirstHostAnim />
								</Group>
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
					)}
				</Stepper.Step>

				{/* Step 5: Live verification */}
				<Stepper.Step
					label={t('onboarding.step5_label')}
					description={t('onboarding.step5_desc')}
					icon={<IconShieldCheck size={18} />}
				>
					{stepBody(4, <VerificationStep onComplete={() => setActive(5)} />)}
				</Stepper.Step>

				{/* Step 6: Done */}
				<Stepper.Completed>
					{stepBody(
						5,
						<Card withBorder>
							<Stack align="center">
								<DoneAnim />
								<Title order={4}>{t('onboarding.done_title')}</Title>
								<Text ta="center">{t('onboarding.done_body')}</Text>
								<Stack gap={4} w="100%">
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
									<Button onClick={onFinish} loading={patchFlags.isPending} size="md">
										{t('onboarding.finish_with_tour')}
									</Button>
								</Group>
								<Text size="xs" c="dimmed">
									{t('onboarding.tour_hint')}
								</Text>
							</Stack>
						</Card>
					)}
				</Stepper.Completed>
			</Stepper>
		</Stack>
	);
}

interface VerificationStepProps {
	onComplete: () => void;
}

function VerificationStep({ onComplete }: VerificationStepProps) {
	const { t } = useTranslation();
	const [statuses, setStatuses] = useState<Record<VerifyKey, 'pending' | 'ok' | 'failed'>>({
		db: 'pending',
		secrets: 'pending',
		cloudflared: 'pending',
		disk: 'pending',
		github: 'pending',
	});
	const [detail, setDetail] = useState<Record<VerifyKey, string | undefined>>({
		db: undefined,
		secrets: undefined,
		cloudflared: undefined,
		disk: undefined,
		github: undefined,
	});
	const [done, setDone] = useState(false);
	const [running, setRunning] = useState(false);

	const run = async () => {
		setRunning(true);
		setDone(false);
		setStatuses({
			db: 'pending',
			secrets: 'pending',
			cloudflared: 'pending',
			disk: 'pending',
			github: 'pending',
		});
		try {
			// Stagger the visual reveal so the spinners get a chance to spin
			// (the deep health-check itself is fast).
			const result = await api<DeepHealthResponse>('/health/deep');
			for (const k of VERIFY_KEYS) {
				await sleep(450);
				const check = result.checks[k];
				setStatuses((s) => ({ ...s, [k]: check?.ok ? 'ok' : 'failed' }));
				setDetail((d) => ({ ...d, [k]: check?.detail }));
			}
		} catch (err) {
			notifications.show({
				color: 'red',
				message: (err as Error).message,
			});
			setStatuses({
				db: 'failed',
				secrets: 'failed',
				cloudflared: 'failed',
				disk: 'failed',
				github: 'failed',
			});
		} finally {
			setDone(true);
			setRunning(false);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: run() is stable
	useEffect(() => {
		void run();
	}, []);

	const okCount = Object.values(statuses).filter((s) => s === 'ok').length;
	const pct = (okCount / VERIFY_KEYS.length) * 100;
	const allOk = okCount === VERIFY_KEYS.length;

	return (
		<Card withBorder>
			<Stack>
				<Group justify="space-between">
					<Title order={4}>
						<IconShieldCheck size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />
						{t('onboarding.step5_title')}
					</Title>
					{!done && <VerifyAnim size={32} />}
				</Group>
				<Text size="sm" c="dimmed">
					{t('onboarding.step5_intro')}
				</Text>
				<Progress value={pct} color={allOk ? 'green' : 'cg-orange'} animated={!done} />
				<Stack gap={6}>
					{VERIFY_KEYS.map((k) => (
						<CheckRow key={k} name={k} status={statuses[k]} detail={detail[k]} />
					))}
				</Stack>
				{done && !allOk && (
					<Alert color="orange" title={t('onboarding.verify_some_failed_title')}>
						{t('onboarding.verify_some_failed_body')}
					</Alert>
				)}
				<Group>
					<Button onClick={onComplete} disabled={!done} variant={allOk ? 'filled' : 'default'}>
						{allOk ? t('onboarding.next') : t('onboarding.continue_anyway')}
					</Button>
					<Button onClick={run} loading={running} variant="subtle">
						{t('onboarding.verify_rerun')}
					</Button>
				</Group>
			</Stack>
		</Card>
	);
}

interface CheckRowProps {
	name: VerifyKey;
	status: 'pending' | 'ok' | 'failed';
	detail: string | undefined;
}

function CheckRow({ name, status, detail }: CheckRowProps) {
	const { t } = useTranslation();
	return (
		<Group justify="space-between" wrap="nowrap">
			<Group gap="xs" wrap="nowrap">
				{status === 'pending' && <VerifyAnim size={20} />}
				{status === 'ok' && <IconCircleCheck size={20} color="#22c55e" />}
				{status === 'failed' && <IconX size={20} color="#ef4444" />}
				<Text size="sm">{t(`onboarding.verify_${name}`)}</Text>
			</Group>
			<Text size="xs" c={status === 'failed' ? 'red' : 'dimmed'} ta="right" style={{ maxWidth: 320 }}>
				{status === 'pending'
					? t('onboarding.verify_running')
					: status === 'failed'
						? (detail ?? t(`onboarding.verify_${name}_failed_hint`))
						: (detail ?? t('onboarding.verify_ok'))}
			</Text>
		</Group>
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
