import { Select } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudflareAccounts, useZones } from '../api/cloudflare.js';

interface Props {
	value: string;
	onChange: (value: string) => void;
	error?: string;
}

/**
 * Optional DNS zone picker for playit hosts. Playit tunnels have no Cloudflare
 * account of their own, so the zone comes from any linked Cloudflare account.
 */
export function PlayitZoneSelect({ value, onChange, error }: Props) {
	const { t } = useTranslation();
	const accounts = useCloudflareAccounts();
	const list = accounts.data?.accounts ?? [];
	const [accountId, setAccountId] = useState<string | null>(null);
	const activeId = accountId ?? (list.length > 0 ? String(list[0]?.id) : null);
	const zones = useZones(activeId ? Number.parseInt(activeId, 10) : null);

	return (
		<>
			{list.length > 1 && (
				<Select
					label={t('hosts.playit_zone_account')}
					value={activeId}
					onChange={(v) => {
						setAccountId(v);
						onChange('');
					}}
					data={list.map((a) => ({ value: String(a.id), label: a.label }))}
				/>
			)}
			<Select
				label={t('hosts.playit_zone_label')}
				placeholder={t('hosts.pick_zone')}
				description={t('hosts.playit_zone_hint')}
				clearable
				disabled={!activeId}
				data={zones.data?.zones.map((z) => ({ value: String(z.id), label: z.name })) ?? []}
				value={value || null}
				onChange={(v) => onChange(v ?? '')}
				error={error}
			/>
		</>
	);
}
