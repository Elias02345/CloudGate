/**
 * Bulk-host CSV import modal.
 *
 * CSV columns (in any order, hostname is required):
 *   hostname, forward_host, forward_port, forward_scheme, mode,
 *   tunnel_id, cf_zone_id, no_tls_verify
 *
 * The first row may be a header. If first row doesn't include "hostname"
 * we treat it as headerless and assume positional columns:
 *   hostname,forward_host,forward_port[,forward_scheme]
 */

import {
	Alert,
	Button,
	Code,
	FileInput,
	Group,
	Modal,
	Select,
	Stack,
	Table,
	Text,
	Textarea,
} from '@mantine/core';
import { IconAlertCircle, IconCheck, IconUpload } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useCloudflareAccounts, useZones } from '../api/cloudflare.js';
import { useTunnels } from '../api/tunnels.js';

interface RowResult {
	row: number;
	hostname: string;
	ok: boolean;
	error?: string;
	id?: number;
}

interface BulkResponse {
	total: number;
	ok: number;
	fail: number;
	results: RowResult[];
}

interface Props {
	opened: boolean;
	onClose: () => void;
}

// Tiny CSV parser — handles quoted strings + commas inside quotes.
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	for (const line of lines) {
		const out: string[] = [];
		let cur = '';
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (inQuotes) {
				if (c === '"' && line[i + 1] === '"') {
					cur += '"';
					i++;
				} else if (c === '"') {
					inQuotes = false;
				} else {
					cur += c;
				}
			} else if (c === '"') {
				inQuotes = true;
			} else if (c === ',') {
				out.push(cur);
				cur = '';
			} else {
				cur += c;
			}
		}
		out.push(cur);
		rows.push(out.map((x) => x.trim()));
	}
	return rows;
}

function rowsToHosts(rows: string[][], defaultTunnelId: number | null, defaultZoneId: number | null): Record<string, unknown>[] {
	if (rows.length === 0) return [];
	const head = rows[0]!;
	const hasHeader = head.some((c) => c.toLowerCase() === 'hostname');
	const fields = hasHeader ? head.map((h) => h.toLowerCase()) : ['hostname', 'forward_host', 'forward_port', 'forward_scheme'];
	const dataRows = hasHeader ? rows.slice(1) : rows;
	return dataRows.map((cells) => {
		const obj: Record<string, unknown> = {};
		fields.forEach((f, i) => {
			if (cells[i] !== undefined && cells[i] !== '') obj[f] = cells[i];
		});
		// Default the CF binding if user picked one in the modal
		if (!obj.tunnel_id && defaultTunnelId !== null) obj.tunnel_id = defaultTunnelId;
		if (!obj.cf_zone_id && defaultZoneId !== null) obj.cf_zone_id = defaultZoneId;
		if (!obj.mode) obj.mode = 'cloudflare_tunnel';
		return obj;
	});
}

export function BulkImportModal({ opened, onClose }: Props) {
	const { t } = useTranslation();
	const qc = useQueryClient();
	const accounts = useCloudflareAccounts();
	const tunnels = useTunnels();
	const [tunnelId, setTunnelId] = useState<string | null>(null);
	const selectedTunnel = tunnels.data?.tunnels.find((tn) => String(tn.id) === tunnelId);
	const zones = useZones(selectedTunnel?.cloudflare_account_id ?? null);
	const [zoneId, setZoneId] = useState<string | null>(null);

	const [csvText, setCsvText] = useState('');
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<BulkResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const onFile = async (f: File | null) => {
		if (!f) return;
		const text = await f.text();
		setCsvText(text);
	};

	const onSubmit = async () => {
		setBusy(true);
		setErr(null);
		setResult(null);
		try {
			const rows = parseCsv(csvText);
			const hosts = rowsToHosts(
				rows,
				tunnelId ? Number.parseInt(tunnelId, 10) : null,
				zoneId ? Number.parseInt(zoneId, 10) : null
			);
			if (hosts.length === 0) throw new Error(t('bulk.empty'));
			const res = await api<BulkResponse>('/hosts/bulk-import', { method: 'POST', body: { hosts } });
			setResult(res);
			qc.invalidateQueries({ queryKey: ['hosts'] });
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const reset = () => {
		setCsvText('');
		setResult(null);
		setErr(null);
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t('bulk.title')} size="xl">
			<Stack>
				{result ? (
					<>
						<Alert color={result.fail === 0 ? 'green' : 'yellow'} icon={<IconCheck size={18} />}>
							{t('bulk.summary', { ok: result.ok, fail: result.fail, total: result.total })}
						</Alert>
						<Table verticalSpacing="xs" striped>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>#</Table.Th>
									<Table.Th>{t('bulk.col_hostname')}</Table.Th>
									<Table.Th>{t('bulk.col_status')}</Table.Th>
									<Table.Th>{t('bulk.col_detail')}</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{result.results.map((r) => (
									<Table.Tr key={r.row}>
										<Table.Td>{r.row}</Table.Td>
										<Table.Td>
											<Text ff="monospace" size="sm">
												{r.hostname}
											</Text>
										</Table.Td>
										<Table.Td>{r.ok ? '✓' : '✗'}</Table.Td>
										<Table.Td>
											<Text size="xs" c={r.ok ? 'dimmed' : 'red'}>
												{r.ok ? `id=${r.id}` : r.error}
											</Text>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
						<Group justify="flex-end">
							<Button variant="default" onClick={reset}>
								{t('bulk.import_more')}
							</Button>
							<Button onClick={onClose}>{t('common.cancel')}</Button>
						</Group>
					</>
				) : (
					<>
						<Text size="sm" c="dimmed">
							{t('bulk.intro')}
						</Text>
						<Text size="xs" c="dimmed">
							{t('bulk.csv_example')}: <Code>hostname,forward_host,forward_port,forward_scheme</Code>
						</Text>

						{accounts.data?.accounts.length === 0 && (
							<Alert color="orange">{t('bulk.no_account_warning')}</Alert>
						)}
						<Group grow>
							<Select
								label={t('bulk.default_tunnel')}
								description={t('bulk.default_tunnel_hint')}
								placeholder={t('tunnels.pick_account')}
								value={tunnelId}
								onChange={setTunnelId}
								data={
									tunnels.data?.tunnels.map((tn) => ({
										value: String(tn.id),
										label: tn.name,
									})) ?? []
								}
								clearable
							/>
							<Select
								label={t('bulk.default_zone')}
								placeholder={t('hosts.pick_zone')}
								value={zoneId}
								onChange={setZoneId}
								disabled={!tunnelId}
								data={
									zones.data?.zones.map((z) => ({
										value: String(z.id),
										label: z.name,
									})) ?? []
								}
								clearable
							/>
						</Group>

						<FileInput
							label={t('bulk.file_field')}
							placeholder="hosts.csv"
							onChange={onFile}
							accept=".csv,text/csv"
						/>
						<Textarea
							label={t('bulk.paste_field')}
							placeholder={'hostname,forward_host,forward_port\nimmich.example.com,192.168.1.10,2283\nnextcloud.example.com,192.168.1.11,80'}
							value={csvText}
							onChange={(e) => setCsvText(e.currentTarget.value)}
							autosize
							minRows={6}
							maxRows={20}
						/>

						{err && (
							<Alert color="red" icon={<IconAlertCircle size={18} />}>
								{err}
							</Alert>
						)}

						<Group justify="flex-end">
							<Button variant="default" onClick={onClose}>
								{t('common.cancel')}
							</Button>
							<Button
								onClick={onSubmit}
								disabled={!csvText.trim()}
								loading={busy}
								leftSection={<IconUpload size={16} />}
							>
								{t('bulk.import_button')}
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Modal>
	);
}
