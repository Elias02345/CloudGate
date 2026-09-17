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
import { runAdminRestore, runBackupExport } from '../api/restore.js';

const BACKUP_CONTENTS = [
	{ paths: ['db/db.sqlite'], desc: 'all hosts, tunnels, accounts, settings' },
	{ paths: ['secrets/'], desc: 'encryption + JWT keys (required to decrypt the DB)' },
	{ paths: ['cloudflared/'], desc: 'tunnel credentials so existing CF tunnels keep working' },
	{ paths: ['nginx/custom/', 'nginx/certs/'], desc: "your snippets and Let's Encrypt certs" },
];

export function BackupPage() {
	return (
		<Stack maw={760}>
			<Title order={2}>Backup &amp; Restore</Title>
			<Text size="sm" c="dimmed">
				One encrypted file contains everything CloudGate needs to come back from a wipe: the database, your
				encryption keys, Cloudflare tunnel credentials, nginx custom snippets and certs. The file is encrypted
				with a passphrase you choose — keep it somewhere safe.{' '}
				<strong>Without the passphrase, the backup is unrecoverable.</strong>
			</Text>

			<ExportCard />
			<Divider />
			<ImportCard />
		</Stack>
	);
}

function ExportCard() {
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
					<Title order={4}>Export backup</Title>
				</Group>
				{/* Filename pattern on its own line: a code span mid-sentence wraps fine in a
				    live browser, but exports as a separate, misaligned fragment in the Penpot
				    mockup — a standalone line captures and reflows cleanly everywhere. */}
				<Text size="sm" c="dimmed">
					Downloads an encrypted backup file (AES-256-GCM, PBKDF2 200k iterations):
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
						Downloaded <code>{last}</code>. Store it somewhere off this machine.
					</Alert>
				)}
				<PasswordInput
					label="Passphrase"
					description="Minimum 8 characters. Pick something strong — there's no recovery without it."
					value={pass}
					onChange={(e) => setPass(e.currentTarget.value)}
					error={tooShort ? 'Passphrase must be at least 8 characters' : undefined}
					leftSection={<IconLock size={16} />}
					required
				/>
				<PasswordInput
					label="Confirm passphrase"
					value={confirm}
					onChange={(e) => setConfirm(e.currentTarget.value)}
					error={mismatch ? 'Passphrases do not match' : undefined}
					required
				/>
				<Box>
					<Button onClick={onExport} loading={busy} disabled={!canExport}>
						Download backup
					</Button>
				</Box>
			</Stack>
		</Card>
	);
}

function ImportCard() {
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
					<Title order={4}>Import backup</Title>
				</Group>
				<Alert color="orange" icon={<IconAlertCircle size={18} />} title="This overwrites everything">
					Restoring replaces the current database, secrets, Cloudflare tunnel credentials, and nginx
					configuration. Any changes made since the backup was taken will be lost.{' '}
					<strong>Restart the container after restore</strong> so the new data is picked up cleanly.
				</Alert>
				{err && (
					<Alert color="red" icon={<IconAlertCircle size={18} />}>
						{err}
					</Alert>
				)}
				{done && (
					<Alert color="green" icon={<IconCheck size={18} />}>
						Restore complete — {done.files} files, {(done.bytes / 1024 / 1024).toFixed(1)} MB extracted.
						Restart the container or use <Anchor href="/api/auth/logout">log out</Anchor> and back in to load
						the restored state.
					</Alert>
				)}
				<FileInput
					label="Backup file"
					placeholder="cloudgate-backup-…cgbk"
					value={file}
					onChange={setFile}
					accept=".cgbk"
					required
				/>
				<PasswordInput
					label="Passphrase (same one used at export)"
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
							I understand this <strong>replaces the current install</strong> and a container restart is
							required afterwards.
						</Text>
					}
				/>
				<Box>
					<Button color="orange" onClick={onImport} loading={busy} disabled={!canImport}>
						Restore from backup
					</Button>
				</Box>
				<Text size="xs" c="dimmed">
					Backup contents:
				</Text>
				{/* Manual bullet + flex text (see the onboarding page for why: Mantine's <List>
				    doesn't hang-indent wrapped lines and drops its marker outside a live browser). */}
				<Stack gap={6}>
					{BACKUP_CONTENTS.map((item) => (
						<Group key={item.desc} gap={8} wrap="nowrap" align="flex-start">
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
								{item.desc}
							</Text>
						</Group>
					))}
				</Stack>
			</Stack>
		</Card>
	);
}
