/**
 * Interactive in-app update flow.
 *
 * One full-screen modal that walks the user through:
 *   1. download archive (live byte counter + percentage)
 *   2. download SHA + GPG sidecars
 *   3. verify checksum + signature
 *   4. hand off to /app/bin/apply-update.sh (backend dies here)
 *   5. container restart — modal switches to polling /api/health
 *   6. backend comes back with new version → SUCCESS card with auto-reload
 *
 * The SSE connection naturally drops mid-step 4. We detect that, switch to
 * a 2-second /api/health poll, interpolate progress 65→95% based on wall
 * clock, and fetch /api/updates/log + /api/updates/last once the new
 * backend is reachable so the user sees what apply-update.sh did.
 */

import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Card,
	Code,
	Collapse,
	Divider,
	Group,
	Modal,
	Progress,
	ScrollArea,
	Stack,
	Text,
	Title,
	Tooltip,
} from '@mantine/core';
import {
	IconAlertTriangle,
	IconArrowUp,
	IconCheck,
	IconChevronDown,
	IconChevronUp,
	IconCircleCheck,
	IconCircleX,
	IconLoader2,
	IconReload,
	IconTerminal2,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getStoredToken } from '../api/client.js';
import {
	type LastUpdateMarker,
	type UpdateStatus,
	type UpdateStep,
	fetchLastUpdate,
	fetchUpdateLog,
	pingHealth,
} from '../api/updates.js';
import './onboarding/animations/animations.css';

interface UpdateProgressModalProps {
	opened: boolean;
	onClose: () => void;
	/** Version we're trying to install. Used for success/failure version comparison. */
	targetVersion: string;
	/** Version we started from. */
	startingVersion: string;
}

/** Ordered list of stages shown in the UI. */
const STAGES: { id: UpdateStep; i18nKey: string }[] = [
	{ id: 'acquire_lock', i18nKey: 'update_modal.stage_lock' },
	{ id: 'download_archive', i18nKey: 'update_modal.stage_download' },
	{ id: 'download_sha', i18nKey: 'update_modal.stage_sha' },
	{ id: 'download_sig', i18nKey: 'update_modal.stage_sig' },
	{ id: 'verify_sha', i18nKey: 'update_modal.stage_verify_sha' },
	{ id: 'verify_gpg', i18nKey: 'update_modal.stage_verify_gpg' },
	{ id: 'spawn_apply', i18nKey: 'update_modal.stage_spawn' },
	{ id: 'apply_running', i18nKey: 'update_modal.stage_apply' },
	{ id: 'done', i18nKey: 'update_modal.stage_done' },
];

const STAGE_ORDER: UpdateStep[] = STAGES.map((s) => s.id);

type Phase =
	| 'connecting' // initial state before any SSE message
	| 'streaming' // SSE is live, we're getting events
	| 'reconnecting' // SSE dropped, polling /api/health
	| 'success' // new backend reachable, version changed →
	| 'rolled_back' // new backend reachable, version unchanged + marker says rolled_back
	| 'failed'; // explicit failure observed

interface InternalProgress {
	step: UpdateStep | null;
	step_label: string | null;
	overall_progress: number;
	download_bytes: number | null;
	download_total: number | null;
}

const INITIAL_PROGRESS: InternalProgress = {
	step: 'acquire_lock',
	step_label: 'Starting…',
	overall_progress: 0,
	download_bytes: null,
	download_total: null,
};

export function UpdateProgressModal({
	opened,
	onClose,
	targetVersion,
	startingVersion,
}: UpdateProgressModalProps) {
	const { t } = useTranslation();
	const [progress, setProgress] = useState<InternalProgress>(INITIAL_PROGRESS);
	const [phase, setPhase] = useState<Phase>('connecting');
	const [logLines, setLogLines] = useState<string[]>([]);
	const [marker, setMarker] = useState<LastUpdateMarker | null>(null);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [autoReloadIn, setAutoReloadIn] = useState<number | null>(null);
	const [spawnedAt, setSpawnedAt] = useState<number | null>(null);
	const logScrollRef = useRef<HTMLDivElement>(null);

	// Reset when the modal closes
	useEffect(() => {
		if (!opened) {
			setProgress(INITIAL_PROGRESS);
			setPhase('connecting');
			setLogLines([]);
			setMarker(null);
			setAutoReloadIn(null);
			setSpawnedAt(null);
		}
	}, [opened]);

	// SSE subscription to `update.progress` + `update.installing` + `update.failed`
	// biome-ignore lint/correctness/useExhaustiveDependencies: phase/spawnedAt would create duplicate EventSource subscriptions if added
	useEffect(() => {
		if (!opened) return;
		const token = getStoredToken();
		if (!token) return;

		const es = new EventSource(
			`/api/events?access_token=${encodeURIComponent(token)}&topics=update.progress,update.installing,update.failed`
		);

		const onProgress = (ev: MessageEvent) => {
			try {
				const env = JSON.parse(ev.data) as {
					payload: {
						step: UpdateStep;
						step_label: string;
						overall_progress: number;
						download_bytes: number | null;
						download_total: number | null;
					};
				};
				const p = env.payload;
				setProgress({
					step: p.step,
					step_label: p.step_label,
					overall_progress: p.overall_progress,
					download_bytes: p.download_bytes,
					download_total: p.download_total,
				});
				if (phase === 'connecting') setPhase('streaming');
				if (p.step === 'apply_running' && spawnedAt === null) {
					setSpawnedAt(Date.now());
				}
			} catch {
				/* ignore */
			}
		};

		const onFailed = (ev: MessageEvent) => {
			try {
				const env = JSON.parse(ev.data) as { payload: { error?: string } };
				appendLog(`✗ ${env.payload.error ?? 'Update failed'}`);
			} catch {
				/* ignore */
			}
			setPhase('failed');
		};

		es.addEventListener('update.progress', onProgress as EventListener);
		es.addEventListener('update.installing', onProgress as EventListener);
		es.addEventListener('update.failed', onFailed as EventListener);

		const appendLog = (line: string) =>
			setLogLines((prev) => [...prev.slice(-499), `[${new Date().toLocaleTimeString()}] ${line}`]);

		appendLog(`Subscribed to update events for target ${targetVersion}`);

		// Detect connection drop. Once apply_running fires the backend will die
		// shortly — we switch to polling mode.
		const onError = () => {
			es.close();
			if (phase !== 'success' && phase !== 'failed' && phase !== 'rolled_back') {
				appendLog('SSE connection dropped — container is restarting');
				setPhase('reconnecting');
			}
		};
		es.addEventListener('error', onError);

		return () => {
			es.removeEventListener('update.progress', onProgress as EventListener);
			es.removeEventListener('update.installing', onProgress as EventListener);
			es.removeEventListener('update.failed', onFailed as EventListener);
			es.removeEventListener('error', onError);
			es.close();
		};
		// We intentionally exclude `phase` and `spawnedAt` — the effect should only
		// run once per `opened` + `targetVersion` to avoid creating duplicate
		// EventSource subscriptions.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [opened, targetVersion]);

	// Wall-clock interpolation between spawn_apply (~65%) and apply_running (~95%)
	useEffect(() => {
		if (phase !== 'reconnecting' && phase !== 'streaming') return;
		if (progress.step !== 'apply_running' && progress.step !== 'spawn_apply') return;
		const interval = setInterval(() => {
			const start = spawnedAt ?? Date.now();
			const elapsed = (Date.now() - start) / 1000; // seconds
			// Estimate apply takes ~75s; cap at 95%.
			const interpolated = Math.min(95, 65 + (elapsed / 75) * 30);
			setProgress((prev) => ({
				...prev,
				overall_progress: Math.max(prev.overall_progress, Math.round(interpolated)),
			}));
		}, 500);
		return () => clearInterval(interval);
	}, [phase, progress.step, spawnedAt]);

	// /api/health poll while reconnecting
	useEffect(() => {
		if (phase !== 'reconnecting') return;
		let cancelled = false;
		const poll = async () => {
			while (!cancelled) {
				const result = await pingHealth(1500);
				if (cancelled) return;
				if (result) {
					if (result.version !== startingVersion) {
						setPhase('success');
						setProgress((p) => ({ ...p, overall_progress: 100, step: 'done', step_label: 'Done' }));
					} else {
						// Backend is back but version didn't change — likely rolled back
						const m = await fetchLastUpdate().catch(() => null);
						if (cancelled) return;
						if (m) setMarker(m);
						if (m?.outcome === 'rolled_back') setPhase('rolled_back');
						else if (m?.outcome === 'failed') setPhase('failed');
						else setPhase('rolled_back'); // best guess
					}
					// Fetch the full log so the user sees what apply did
					const log = await fetchUpdateLog(300).catch(() => ({ lines: [], byte_offset: 0 }));
					if (cancelled) return;
					if (log.lines.length > 0) {
						setLogLines((prev) => [...prev, '— historical log —', ...log.lines]);
					}
					return;
				}
				await sleep(2000);
			}
		};
		void poll();
		return () => {
			cancelled = true;
		};
	}, [phase, startingVersion]);

	// Auto-reload countdown after success
	useEffect(() => {
		if (phase !== 'success') return;
		setAutoReloadIn(5);
		const tick = setInterval(() => {
			setAutoReloadIn((n) => {
				if (n === null) return null;
				if (n <= 1) {
					window.location.reload();
					return 0;
				}
				return n - 1;
			});
		}, 1000);
		return () => clearInterval(tick);
	}, [phase]);

	// Auto-scroll terminal to bottom
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the length change matters here
	useEffect(() => {
		if (logScrollRef.current) {
			logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
		}
	}, [logLines.length]);

	// ---------------------------------------------------------------------
	// Derived view-model
	// ---------------------------------------------------------------------

	const currentStageIdx = progress.step ? STAGE_ORDER.indexOf(progress.step) : 0;
	const downloadHuman = useMemo(() => {
		if (progress.download_bytes === null) return null;
		const fmt = (n: number): string =>
			n < 1024
				? `${n} B`
				: n < 1024 * 1024
					? `${(n / 1024).toFixed(1)} KB`
					: `${(n / 1024 / 1024).toFixed(2)} MB`;
		if (progress.download_total) {
			return `${fmt(progress.download_bytes)} / ${fmt(progress.download_total)}`;
		}
		return fmt(progress.download_bytes);
	}, [progress.download_bytes, progress.download_total]);

	const isTerminal = phase === 'success' || phase === 'failed' || phase === 'rolled_back';
	const headerIcon =
		phase === 'success' ? (
			<IconCircleCheck size={28} color="#22c55e" />
		) : phase === 'failed' ? (
			<IconCircleX size={28} color="#ef4444" />
		) : phase === 'rolled_back' ? (
			<IconAlertTriangle size={28} color="#f59e0b" />
		) : (
			<IconArrowUp size={28} color="#ff6620" className="cg-anim-pulse" />
		);

	const headerColor =
		phase === 'success'
			? 'green'
			: phase === 'failed'
				? 'red'
				: phase === 'rolled_back'
					? 'orange'
					: 'cg-orange';

	const phaseLabel =
		phase === 'connecting'
			? t('update_modal.phase_connecting')
			: phase === 'streaming'
				? t('update_modal.phase_streaming')
				: phase === 'reconnecting'
					? t('update_modal.phase_reconnecting')
					: phase === 'success'
						? t('update_modal.phase_success')
						: phase === 'rolled_back'
							? t('update_modal.phase_rolled_back')
							: t('update_modal.phase_failed');

	// ---------------------------------------------------------------------

	return (
		<Modal
			opened={opened}
			onClose={isTerminal ? onClose : () => {}}
			withCloseButton={isTerminal}
			closeOnClickOutside={false}
			closeOnEscape={isTerminal}
			size="xl"
			centered
			padding="lg"
			title={
				<Group gap="sm">
					{headerIcon}
					<div>
						<Title order={3}>
							{phase === 'success'
								? t('update_modal.title_success', { version: targetVersion })
								: phase === 'failed'
									? t('update_modal.title_failed')
									: phase === 'rolled_back'
										? t('update_modal.title_rolled_back')
										: t('update_modal.title_installing', { version: targetVersion })}
						</Title>
						<Text size="xs" c="dimmed">
							{t('update_modal.from_to', { from: startingVersion, to: targetVersion })}
						</Text>
					</div>
				</Group>
			}
		>
			<Stack gap="md">
				{/* Phase badge + progress bar */}
				<Stack gap={4}>
					<Group justify="space-between">
						<Badge color={headerColor} variant="light" size="lg">
							{phaseLabel}
						</Badge>
						<Text size="sm" c="dimmed">
							{progress.overall_progress}%
						</Text>
					</Group>
					<Progress
						value={progress.overall_progress}
						color={
							phase === 'success'
								? 'green'
								: phase === 'failed' || phase === 'rolled_back'
									? 'red'
									: 'cg-orange'
						}
						animated={!isTerminal}
						size="lg"
						radius="md"
					/>
					{progress.step_label && (
						<Text size="sm" mt={4}>
							{progress.step_label}
							{downloadHuman && (
								<Text component="span" c="dimmed" ml="xs">
									({downloadHuman})
								</Text>
							)}
						</Text>
					)}
				</Stack>

				{/* Phase-specific cards */}
				{phase === 'success' && (
					<Alert color="green" icon={<IconCircleCheck size={20} />} title={t('update_modal.success_title')}>
						<Stack gap="xs">
							<Text size="sm">{t('update_modal.success_body', { version: targetVersion })}</Text>
							<Group>
								<Button
									leftSection={<IconReload size={16} />}
									onClick={() => window.location.reload()}
									color="green"
								>
									{autoReloadIn !== null
										? t('update_modal.reload_in', { seconds: autoReloadIn })
										: t('update_modal.reload_now')}
								</Button>
							</Group>
						</Stack>
					</Alert>
				)}

				{phase === 'rolled_back' && marker && (
					<Alert
						color="orange"
						icon={<IconAlertTriangle size={20} />}
						title={t('update_modal.rolled_back_title')}
					>
						<Stack gap="xs">
							<Text size="sm">{t('update_modal.rolled_back_body')}</Text>
							<Code block>{marker.reason}</Code>
						</Stack>
					</Alert>
				)}

				{phase === 'failed' && (
					<Alert color="red" icon={<IconCircleX size={20} />} title={t('update_modal.failed_title')}>
						<Text size="sm">{t('update_modal.failed_body')}</Text>
					</Alert>
				)}

				{/* Stage list */}
				<Card withBorder padding="sm">
					<Stack gap={6}>
						{STAGES.map((stage, idx) => {
							const isDone = idx < currentStageIdx || phase === 'success';
							const isCurrent = idx === currentStageIdx && !isTerminal;
							const isUpcoming = idx > currentStageIdx && !isTerminal;
							return (
								<Group key={stage.id} gap="xs" wrap="nowrap">
									{isDone ? (
										<IconCheck size={16} color="#22c55e" />
									) : isCurrent ? (
										<IconLoader2 size={16} color="#ff6620" className="cg-anim-spin" />
									) : (
										<Box
											w={16}
											h={16}
											style={{ borderRadius: 8, border: '1.5px solid var(--mantine-color-gray-5)' }}
										/>
									)}
									<Text
										size="sm"
										c={isDone ? undefined : isCurrent ? undefined : 'dimmed'}
										fw={isCurrent ? 600 : 400}
									>
										{t(stage.i18nKey)}
									</Text>
								</Group>
							);
						})}
					</Stack>
				</Card>

				{/* Collapsible terminal */}
				<Card withBorder padding={0}>
					<Group
						justify="space-between"
						px="md"
						py="xs"
						style={{
							cursor: 'pointer',
							borderBottom: terminalOpen ? '1px solid var(--mantine-color-gray-3)' : 'none',
						}}
						onClick={() => setTerminalOpen((v) => !v)}
					>
						<Group gap="xs">
							<IconTerminal2 size={16} />
							<Text size="sm" fw={500}>
								{t('update_modal.terminal_toggle')}
							</Text>
							<Badge size="xs" variant="light" color="gray">
								{logLines.length}
							</Badge>
						</Group>
						<ActionIcon variant="subtle" size="sm">
							{terminalOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
						</ActionIcon>
					</Group>
					<Collapse in={terminalOpen}>
						<ScrollArea h={260} viewportRef={logScrollRef}>
							<Box
								p="sm"
								style={{
									fontFamily: 'monospace',
									fontSize: 12,
									background: 'var(--mantine-color-dark-8, #1a1b1e)',
									color: 'var(--mantine-color-gray-2, #e0e0e0)',
									minHeight: 260,
								}}
							>
								{logLines.length === 0 ? (
									<Text size="xs" c="dimmed">
										{t('update_modal.terminal_empty')}
									</Text>
								) : (
									logLines.map((line, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: append-only log; index is a stable identity
										<div key={`${i}-${line.slice(0, 24)}`} style={{ whiteSpace: 'pre-wrap' }}>
											{line}
										</div>
									))
								)}
							</Box>
						</ScrollArea>
					</Collapse>
				</Card>

				{/* Footer hint */}
				{!isTerminal && (
					<Group justify="space-between" align="center">
						<Text size="xs" c="dimmed">
							{t('update_modal.no_close_hint')}
						</Text>
						{phase === 'reconnecting' && (
							<Tooltip label={t('update_modal.health_polling_hint')}>
								<Badge variant="dot" color="yellow">
									{t('update_modal.polling_health')}
								</Badge>
							</Tooltip>
						)}
					</Group>
				)}

				{isTerminal && phase !== 'success' && (
					<Group justify="flex-end">
						<Anchor href="/__recovery/" target="_blank" rel="noreferrer" size="sm">
							{t('update_modal.open_recovery')}
						</Anchor>
						<Button variant="default" onClick={onClose}>
							{t('common.close' as never, { defaultValue: 'Close' })}
						</Button>
					</Group>
				)}
			</Stack>
		</Modal>
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convenience helper: when a parent's UpdatesPage wants to kick off an
 * install + immediately open the modal. Exported here so the page doesn't
 * have to know about phase state details.
 */
export function shouldShowModalForStatus(status: UpdateStatus | undefined): boolean {
	if (!status) return false;
	return (
		status.state === 'downloading' ||
		status.state === 'verifying' ||
		status.state === 'installing' ||
		status.state === 'rolling_back'
	);
}
