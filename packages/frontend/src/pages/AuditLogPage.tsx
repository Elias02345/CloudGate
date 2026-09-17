import {
	Badge,
	Box,
	Card,
	Center,
	Code,
	Group,
	Pagination,
	Paper,
	Popover,
	Stack,
	Table,
	Text,
	Title,
} from '@mantine/core';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuditLog } from '../api/audit.js';

const ACTION_COLORS: Record<string, string> = {
	'auth.login': 'green',
	'totp.enabled': 'cyan',
	'totp.disabled': 'orange',
	'backup.exported': 'blue',
	'update.installed': 'grape',
};

function InfoLine({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Group gap={6} wrap="nowrap" align="baseline">
			<Text size="xs" c="dimmed" w={88} style={{ flexShrink: 0 }}>
				{label}
			</Text>
			<Box style={{ minWidth: 0 }}>{children}</Box>
		</Group>
	);
}

/** `{}` chip that opens an entry's metadata as JSON. A flex box rather than inline-flex, so it no longer sits on the text baseline below the row centre. */
function MetaChip({
	meta,
	position,
	size,
	maw,
}: { meta: unknown; position: 'left' | 'bottom'; size: number; maw: number }) {
	return (
		<Popover position={position} withArrow shadow="sm">
			<Popover.Target>
				<Code
					className="cg-clickable"
					w={size}
					h={size}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: 0,
						flexShrink: 0,
						fontSize: size < 20 ? 11 : 12,
					}}
				>
					{'{}'}
				</Code>
			</Popover.Target>
			<Popover.Dropdown>
				<Code block maw={maw} mah={300} style={{ overflow: 'auto' }}>
					{JSON.stringify(meta ?? {}, null, 2)}
				</Code>
			</Popover.Dropdown>
		</Popover>
	);
}

export function AuditLogPage() {
	const { t } = useTranslation();
	const [page, setPage] = useState(1);
	const { data, isLoading } = useAuditLog({ page });

	const totalPages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;

	return (
		<Stack>
			<Title order={2}>{t('audit.title')}</Title>
			<Text c="dimmed" size="sm">
				{t('audit.description')}
			</Text>

			<Card withBorder data-tour="audit-filters">
				<Stack>
					{isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{data && data.data.length === 0 && (
						<Text c="dimmed" ta="center" py="md">
							{t('audit.empty')}
						</Text>
					)}
					{data && data.data.length > 0 && (
						<>
							<Box visibleFrom="sm">
								<Table.ScrollContainer minWidth={900}>
									<Table verticalSpacing="xs" striped>
										<Table.Thead>
											<Table.Tr>
												<Table.Th w={160}>{t('audit.col_when')}</Table.Th>
												<Table.Th ta="center" w={262}>
													{t('audit.col_action')}
												</Table.Th>
												<Table.Th>{t('audit.col_entity')}</Table.Th>
												<Table.Th w={135}>{t('audit.col_ip')}</Table.Th>
												<Table.Th ta="center" w={150}>
													{t('audit.col_meta')}
												</Table.Th>
											</Table.Tr>
										</Table.Thead>
										<Table.Tbody>
											{data.data.map((row) => (
												<Table.Tr key={row.id}>
													<Table.Td>
														<Text size="xs" ff="monospace">
															{row.created_at.replace('T', ' ').slice(0, 19)}
														</Text>
													</Table.Td>
													<Table.Td ta="center">
														<Badge color={ACTION_COLORS[row.action] ?? 'gray'} variant="light">
															{row.action}
														</Badge>
													</Table.Td>
													<Table.Td>
														<Text size="sm">
															{row.entity_type ? `${row.entity_type}#${row.entity_id ?? '—'}` : '—'}
														</Text>
													</Table.Td>
													<Table.Td>
														<Text size="xs" ff="monospace" c="dimmed">
															{row.ip ?? '—'}
														</Text>
													</Table.Td>
													<Table.Td>
														<Center>
															<MetaChip meta={row.meta} position="left" size={18} maw={400} />
														</Center>
													</Table.Td>
												</Table.Tr>
											))}
										</Table.Tbody>
									</Table>
								</Table.ScrollContainer>
							</Box>
							<Stack gap="xs" hiddenFrom="sm">
								{data.data.map((row) => (
									<Paper key={row.id} withBorder radius="md" p="sm">
										<Stack gap={6}>
											{/* wrap: long action names push the timestamp to the next line instead of being cut off */}
											<Group justify="space-between" wrap="wrap" gap={6} align="center">
												<Badge color={ACTION_COLORS[row.action] ?? 'gray'} variant="light" maw="100%">
													{row.action}
												</Badge>
												<Text size="xs" c="dimmed" ff="monospace">
													{row.created_at.replace('T', ' ').slice(0, 19)}
												</Text>
											</Group>
											{/* Details chip vertically centred beside entity + IP */}
											<Group justify="space-between" wrap="nowrap" gap="xs">
												<Stack gap={6} style={{ minWidth: 0 }}>
													<InfoLine label={t('audit.col_entity')}>
														<Text size="sm">
															{row.entity_type ? `${row.entity_type}#${row.entity_id ?? '—'}` : '—'}
														</Text>
													</InfoLine>
													<InfoLine label={t('audit.col_ip')}>
														<Text size="xs" ff="monospace" c="dimmed">
															{row.ip ?? '—'}
														</Text>
													</InfoLine>
												</Stack>
												<MetaChip meta={row.meta} position="bottom" size={22} maw={320} />
											</Group>
										</Stack>
									</Paper>
								))}
							</Stack>
						</>
					)}
					{data && totalPages > 1 && (
						<Group justify="center">
							<Pagination value={page} onChange={setPage} total={totalPages} />
						</Group>
					)}
				</Stack>
			</Card>
		</Stack>
	);
}
