import {
	Alert,
	Anchor,
	Button,
	Card,
	FileInput,
	Group,
	PasswordInput,
	Stack,
	Text,
	Title,
} from '@mantine/core';
import { IconAlertCircle, IconCheck, IconRestore } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { runFirstRunRestore } from '../api/restore.js';

/**
 * Standalone page reachable at /restore. Always visible — but only
 * actually allowed by the backend if /data is fresh (no install yet).
 */
export function RestorePage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const [file, setFile] = useState<File | null>(null);
	const [pass, setPass] = useState('');
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [done, setDone] = useState<{ files: number; bytes: number } | null>(null);

	const onRestore = async () => {
		if (!file || pass.length < 8) return;
		setBusy(true);
		setErr(null);
		try {
			const res = await runFirstRunRestore(file, pass);
			setDone({ files: res.files, bytes: res.bytes });
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Stack align="center" mt="xl">
			<Card withBorder radius="md" w={520}>
				<Stack>
					<Group>
						<IconRestore size={24} color="#ff7030" />
						<Title order={3}>{t('restore.title')}</Title>
					</Group>
					<Text size="sm" c="dimmed">
						{t('restore.intro')}
					</Text>
					<Text size="xs" c="dimmed">
						<Anchor component={Link} to="/login">
							{t('restore.back_to_login')}
						</Anchor>
					</Text>

					{done ? (
						<>
							<Alert color="green" icon={<IconCheck size={18} />} title={t('restore.success_title')}>
								{t('restore.success_body', { files: done.files, mb: (done.bytes / 1024 / 1024).toFixed(1) })}
							</Alert>
							<Button onClick={() => navigate('/login')}>{t('restore.go_to_login')}</Button>
							<Text size="xs" c="dimmed">
								{t('restore.restart_hint')}
							</Text>
						</>
					) : (
						<>
							{err && (
								<Alert color="red" icon={<IconAlertCircle size={18} />}>
									{err}
								</Alert>
							)}
							<FileInput
								label={t('restore.file_field')}
								placeholder="cloudgate-backup-XXXX.cgbk"
								value={file}
								onChange={setFile}
								accept=".cgbk"
								required
							/>
							<PasswordInput
								label={t('restore.passphrase_field')}
								value={pass}
								onChange={(e) => setPass(e.currentTarget.value)}
								minLength={8}
								required
							/>
							<Button
								onClick={onRestore}
								loading={busy}
								disabled={!file || pass.length < 8}
								leftSection={<IconRestore size={16} />}
							>
								{t('restore.submit')}
							</Button>
							<Text size="xs" c="dimmed">
								{t('restore.note')}
							</Text>
						</>
					)}
				</Stack>
			</Card>
		</Stack>
	);
}
