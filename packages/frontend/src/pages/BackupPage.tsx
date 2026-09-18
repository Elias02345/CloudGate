import {
	Alert,
	Anchor,
	Box,
	Button,
	Card,
	Checkbox,
	Divider,
	FileInput,
	Group,
	PasswordInput,
	Stack,
	Text,
	Title,
} from '@mantine/core';
import {
	IconAlertCircle,
	IconCheck,
	IconCloudDownload,
	IconCloudUpload,
	IconLock,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runAdminRestore, runBackupExport } from '../api/restore.js';

const BACKUP_CONTENTS = [
	{ paths: ['db/db.sqlite'], descKey: 'backup.contents_db' },
	{ paths: ['secrets/'], descKey: 'backup.contents_secrets' },
	{ paths: ['cloudflared/'], descKey: 'backup.contents_cloudflared' },
	{ paths: ['nginx/custom/', 'nginx/certs/'], descKey: 'backup.contents_nginx' },
];

export function BackupPage() {
	const { t } = useTranslation();
	return (
		<Stack maw={760}>
			<Title order={2}>{t('backup.title')}</Title>
			<Text size="sm" c="dimmed">
				{t('backup.intro')} <strong>{t('backup.intro_warning')}</strong>
			</Text>

			<ExportCard />
			<Divider />
			<ImportCard />
		</Stack>
	);
}

function ExportCard() {
	const { t } = useTranslation();
	const [pass, setPass] = useState('');
	const [confirm, setConfirm] = useState('');
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [last, setLast] = useState<string | null>(null);

	const tooShort = pass.length > 0 && pass.length < 8;
	const mismatch = confirm.length > 0 && pass !== confirm;
	const canExport = pass.length >= 8 && pass === confirm;

	const onExport = async (): Promise<void> => {
		setErr(null);
		setBusy(true);
		try {
			const { blob, filename } = await runBackupExport(pass);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			setLast(filename);
			setPass('');
			setConfirm('');
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card withBorder>
			<Stack>
				<Group gap="xs">
					<IconCloudDownload size={20} color="#3b82f6" />
					<Title order={4}>{t('backup.export_title')}</Title>
				</Group>
				{/* Filename pattern on its own line: a code span mid-sentence wraps fine in a
				    live browser, but exports as a separate, misaligned fragment in the Penpot
				    mockup — a standalone line captures and reflows cleanly everywhere. */}
				<Text size="sm" c="dimmed">
					{t('backup.export_hint')}
				</Text>
				<Text size="sm" c="dimmed" ff="monospace">
					cloudgate-backup-YYYY-MM-DD…cgbk
				</Text>
				{err && (
					<Alert color="red" icon={<IconAlertCircle size={18} />}>
						{err}
					</Alert>
				)}
				{last && (
					<Alert color="green" icon={<IconCheck size={18} />}>
						{t('backup.export_success_prefix')} <code>{last}</code>. {t('backup.export_success_suffix')}
					</Alert>
				)}
				<PasswordInput
					label={t('backup.passphrase_field')}
					description={t('backup.passphrase_hint')}
					value={pass}
					onChange={(e) => setPass(e.currentTarget.value)}
					error={tooShort ? t('backup.passphrase_too_short') : undefined}
					leftSection={<IconLock size={16} />}
					required
				/>
				<PasswordInput
					label={t('backup.passphrase_confirm_field')}
					value={confirm}
					onChange={(e) => setConfirm(e.currentTarget.value)}
					error={mismatch ? t('backup.passphrase_mismatch') : undefined}
					required
				/>
				<Box>
					<Button onClick={onExport} loading={busy} disabled={!canExport}>
						{t('backup.export_button')}
					</Button>
				</Box>
			</Stack>
		</Card>
	);
}

function ImportCard() {
	const { t } = useTranslation();
	const [file, setFile] = useState<File | null>(null);
	const [pass, setPass] = useState('');
	const [confirmOverwrite, setConfirmOverwrite] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [done, setDone] = useState<{ files: number; bytes: number } | null>(null);

	const canImport = !!file && pass.length >= 8 && confirmOverwrite;

	const onImport = async (): Promise<void> => {
		if (!file) return;
		setErr(null);
		setBusy(true);
		try {
			const result = await runAdminRestore(file, pass, { force: true });
			setDone({ files: result.files, bytes: result.bytes });
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card withBorder>
			<Stack>
				<Group gap="xs">
					<IconCloudUpload size={20} color="#f59e0b" />
					<Title order={4}>{t('backup.import_title')}</Title>
				</Group>
				<Alert color="orange" icon={<IconAlertCircle size={18} />} title={t('backup.import_warning_title')}>
					{t('backup.import_warning_body')} <strong>{t('backup.import_warning_restart')}</strong>{' '}
					{t('backup.import_warning_suffix')}
				</Alert>
				{err && (
					<Alert color="red" icon={<IconAlertCircle size={18} />}>
						{err}
					</Alert>
				)}
				{done && (
					<Alert color="green" icon={<IconCheck size={18} />}>
						{t('backup.import_success', { files: done.files, mb: (done.bytes / 1024 / 1024).toFixed(1) })}{' '}
						<Anchor href="/api/auth/logout">{t('backup.import_success_logout')}</Anchor>{' '}
						{t('backup.import_success_suffix')}
					</Alert>
				)}
				<FileInput
					label={t('backup.file_field')}
					placeholder="cloudgate-backup-…cgbk"
					value={file}
					onChange={setFile}
					accept=".cgbk"
					required
				/>
				<PasswordInput
					label={t('backup.import_passphrase_field')}
					value={pass}
					onChange={(e) => setPass(e.currentTarget.value)}
					leftSection={<IconLock size={16} />}
					required
				/>
				<Checkbox
					checked={confirmOverwrite}
					onChange={(e) => setConfirmOverwrite(e.currentTarget.checked)}
					label={
						<Text size="sm">
							{t('backup.confirm_overwrite')} <strong>{t('backup.confirm_overwrite_bold')}</strong>{' '}
							{t('backup.confirm_overwrite_suffix')}
						</Text>
					}
				/>
				<Box>
					<Button color="orange" onClick={onImport} loading={busy} disabled={!canImport}>
						{t('backup.import_button')}
					</Button>
				</Box>
				<Text size="xs" c="dimmed">
					{t('backup.contents_label')}
				</Text>
				{/* Manual bullet + flex text (see the onboarding page for why: Mantine's <List>
				    doesn't hang-indent wrapped lines and drops its marker outside a live browser). */}
				<Stack gap={6}>
					{BACKUP_CONTENTS.map((item) => (
						<Group key={item.descKey} gap={8} wrap="nowrap" align="flex-start">
							<Text size="xs" c="dimmed">
								•
							</Text>
							<Text size="xs" c="dimmed" style={{ flex: 1 }}>
								{item.paths.map((p, i) => (
									<span key={p}>
										{i > 0 && ' + '}
										<code>{p}</code>
									</span>
								))}
								{' — '}
								{t(item.descKey)}
							</Text>
						</Group>
					))}
				</Stack>
			</Stack>
		</Card>
	);
}
