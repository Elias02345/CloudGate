import { Badge, Card, Code, Group, Pagination, Stack, Table, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuditLog } from '../api/audit.js';

const ACTION_COLORS: Record<string, string> = {
	'auth.login': 'green',
	'totp.enabled': 'cyan',
	'totp.disabled': 'orange',
	'backup.exported': 'blue',
	'update.installed': 'grape',
};

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

			<Card withBorder>
				<Stack>
					{isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{data && data.data.length === 0 && (
						<Text c="dimmed" ta="center" py="md">
							{t('audit.empty')}
						</Text>
					)}
					{data && data.data.length > 0 && (
						<Table verticalSpacing="xs" striped>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t('audit.col_when')}</Table.Th>
									<Table.Th>{t('audit.col_action')}</Table.Th>
									<Table.Th>{t('audit.col_entity')}</Table.Th>
									<Table.Th>{t('audit.col_ip')}</Table.Th>
									<Table.Th>{t('audit.col_meta')}</Table.Th>
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
										<Table.Td>
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
											{row.meta ? (
												<Code style={{ fontSize: 11 }}>{JSON.stringify(row.meta)}</Code>
											) : (
												<Text size="xs" c="dimmed">
													—
												</Text>
											)}
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
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
