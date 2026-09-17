/**
 * Manage shell API keys.
 *
 * Cards-style table with name, prefix, scope, last-used, expires + actions.
 * Create modal returns the full plaintext key once — surfaced via a second
 * modal with a copy-button and a red "save this, it won't be shown again"
 * banner.
 */

import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Group,
	Modal,
	Paper,
	Radio,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck, IconCopy, IconKey, IconRefresh, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	type ApiKey,
	useApiKeys,
	useCreateApiKey,
	useRevokeApiKey,
	useRotateApiKey,
} from '../api/api-keys.js';
import { ApiError } from '../api/client.js';
import { CopyButton } from '../components/CopyButton.js';
import { Tooltip } from '../components/Tooltip.js';

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

export function ApiKeysPage() {
	const { t } = useTranslation();
	const keys = useApiKeys();
	const create = useCreateApiKey();
	const revoke = useRevokeApiKey();
	const rotate = useRotateApiKey();

	const [createOpened, createModal] = useDisclosure(false);
	const [shownPlaintext, setShownPlaintext] = useState<string | null>(null);
	const [shownPrefix, setShownPrefix] = useState<string | null>(null);

	const form = useForm<{ name: string; scope: 'read' | 'admin' }>({
		initialValues: { name: '', scope: 'admin' },
		validate: {
			name: (v) => (v.trim().length >= 1 ? null : t('api_keys.name_required')),
		},
	});

	const onCreate = form.onSubmit(async (values) => {
		try {
			const result = await create.mutateAsync({ name: values.name, scope: values.scope });
			setShownPlaintext(result.plaintext);
			setShownPrefix(result.key.prefix);
			form.reset();
			createModal.close();
		} catch (err) {
			notifications.show({
				color: 'red',
				message: err instanceof ApiError ? `${err.message} (${err.code})` : (err as Error).message,
			});
		}
	});

	const onRevoke = async (k: ApiKey) => {
		if (!confirm(t('api_keys.confirm_revoke', { name: k.name }))) return;
		try {
			await revoke.mutateAsync(k.id);
			notifications.show({ color: 'green', message: t('api_keys.revoked') });
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const onRotate = async (k: ApiKey) => {
		if (!confirm(t('api_keys.confirm_rotate', { name: k.name }))) return;
		try {
			const result = await rotate.mutateAsync(k.id);
			setShownPlaintext(result.plaintext);
			setShownPrefix(result.key.prefix);
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	return (
		<Stack>
			<Group justify="space-between" wrap="wrap" gap="sm">
				<Group>
					<IconKey size={26} color="#ff6620" />
					<Title order={2}>{t('api_keys.title')}</Title>
				</Group>
				<Button onClick={createModal.open}>{t('api_keys.create')}</Button>
			</Group>

			<Card withBorder>
				<Stack gap="xs">
					<Text size="sm" c="dimmed">
						{t('api_keys.intro')}
					</Text>
					<Text size="xs" c="dimmed">
						{t('api_keys.docs_hint')}
					</Text>
				</Stack>
			</Card>

			<Card withBorder>
				<Stack>
					{keys.isLoading && <Text c="dimmed">{t('common.loading')}</Text>}
					{keys.data && keys.data.keys.length === 0 && (
						<Text c="dimmed" ta="center" py="md">
							{t('api_keys.empty')}
						</Text>
					)}
					{keys.data && keys.data.keys.length > 0 && (
						<Box visibleFrom="sm">
							<Table.ScrollContainer minWidth={800}>
								<Table verticalSpacing="sm">
									<Table.Thead>
										<Table.Tr>
											<Table.Th w={224}>{t('api_keys.col_name')}</Table.Th>
											<Table.Th w={130}>{t('api_keys.col_prefix')}</Table.Th>
											<Table.Th ta="center" w={204}>
												{t('api_keys.col_scope')}
											</Table.Th>
											<Table.Th w={320}>{t('api_keys.col_last_used')}</Table.Th>
											<Table.Th w={194}>{t('api_keys.col_expires')}</Table.Th>
											<Table.Th />
										</Table.Tr>
									</Table.Thead>
									<Table.Tbody>
										{keys.data.keys.map((k) => (
											<Table.Tr key={k.id}>
												<Table.Td>
													<Text fw={500}>{k.name}</Text>
												</Table.Td>
												<Table.Td>
													<Text ff="monospace" size="sm">
														{k.prefix}…
													</Text>
												</Table.Td>
												<Table.Td ta="center">
													<Badge color={k.scope === 'admin' ? 'orange' : 'cyan'} variant="light">
														{k.scope}
													</Badge>
												</Table.Td>
												<Table.Td>
													<Text size="xs" c="dimmed">
														{k.last_used_at
															? `${k.last_used_at.replace('T', ' ').slice(0, 16)} (${k.last_used_ip ?? '?'})`
															: t('api_keys.never_used')}
													</Text>
												</Table.Td>
												<Table.Td>
													<Text size="xs" c="dimmed">
														{k.expires_at?.slice(0, 10) ?? t('api_keys.no_expiry')}
													</Text>
												</Table.Td>
												<Table.Td>
													<Group gap={4} justify="flex-end">
														<Tooltip label={t('api_keys.rotate')}>
															<ActionIcon
																variant="subtle"
																color="yellow"
																onClick={() => void onRotate(k)}
																loading={rotate.isPending}
															>
																<IconRefresh size={16} />
															</ActionIcon>
														</Tooltip>
														<Tooltip label={t('api_keys.revoke')}>
															<ActionIcon variant="subtle" color="red" onClick={() => void onRevoke(k)}>
																<IconTrash size={16} />
															</ActionIcon>
														</Tooltip>
													</Group>
												</Table.Td>
											</Table.Tr>
										))}
									</Table.Tbody>
								</Table>
							</Table.ScrollContainer>
						</Box>
					)}
					{keys.data && keys.data.keys.length > 0 && (
						<Stack gap="xs" hiddenFrom="sm">
							{keys.data.keys.map((k) => (
								<Paper key={k.id} withBorder radius="md" p="sm">
									<Stack gap={6}>
										<Group justify="space-between" wrap="nowrap" align="flex-start">
											<Text fw={600} style={{ wordBreak: 'break-word', minWidth: 0 }}>
												{k.name}
											</Text>
											<Badge color={k.scope === 'admin' ? 'orange' : 'cyan'} variant="light">
												{k.scope}
											</Badge>
										</Group>
										<InfoLine label={t('api_keys.col_prefix')}>
											<Text ff="monospace" size="sm">
												{k.prefix}…
											</Text>
										</InfoLine>
										<InfoLine label={t('api_keys.col_last_used')}>
											<Text size="xs" c="dimmed">
												{k.last_used_at
													? `${k.last_used_at.replace('T', ' ').slice(0, 16)} (${k.last_used_ip ?? '?'})`
													: t('api_keys.never_used')}
											</Text>
										</InfoLine>
										<InfoLine label={t('api_keys.col_expires')}>
											<Text size="xs" c="dimmed">
												{k.expires_at?.slice(0, 10) ?? t('api_keys.no_expiry')}
											</Text>
										</InfoLine>
										<Group gap="xs" justify="flex-end">
											<ActionIcon
												variant="subtle"
												color="yellow"
												size="lg"
												onClick={() => void onRotate(k)}
												loading={rotate.isPending}
												title={t('api_keys.rotate')}
											>
												<IconRefresh size={18} />
											</ActionIcon>
											<ActionIcon
												variant="subtle"
												color="red"
												size="lg"
												onClick={() => void onRevoke(k)}
												title={t('api_keys.revoke')}
											>
												<IconTrash size={18} />
											</ActionIcon>
										</Group>
									</Stack>
								</Paper>
							))}
						</Stack>
					)}
				</Stack>
			</Card>

			{/* Create modal */}
			<Modal opened={createOpened} onClose={createModal.close} title={t('api_keys.create_title')}>
				<form onSubmit={onCreate}>
					<Stack>
						<TextInput
							label={t('api_keys.name_field')}
							placeholder="my-laptop-script"
							{...form.getInputProps('name')}
							required
						/>
						<Radio.Group label={t('api_keys.scope_field')} {...form.getInputProps('scope')}>
							<Stack gap="xs" mt="xs">
								<Radio
									value="admin"
									label={t('api_keys.scope_admin')}
									description={t('api_keys.scope_admin_hint')}
								/>
								<Radio
									value="read"
									label={t('api_keys.scope_read')}
									description={t('api_keys.scope_read_hint')}
								/>
							</Stack>
						</Radio.Group>
						<Box>
							<Button type="submit" loading={create.isPending}>
								{t('api_keys.create_submit')}
							</Button>
						</Box>
					</Stack>
				</form>
			</Modal>

			{/* Plaintext-display modal — shown after create or rotate */}
			<Modal
				opened={shownPlaintext !== null}
				onClose={() => {
					setShownPlaintext(null);
					setShownPrefix(null);
				}}
				title={t('api_keys.created_title')}
				size="lg"
			>
				<Stack>
					<Alert color="red" icon={<IconAlertCircle size={18} />}>
						{t('api_keys.shown_once_warning')}
					</Alert>
					{shownPrefix && (
						<Text size="xs" c="dimmed">
							{t('api_keys.prefix_label')}: <strong>{shownPrefix}</strong>
						</Text>
					)}
					<Card withBorder p="md" bg="dark.6">
						<Group justify="space-between" wrap="nowrap">
							<Text ff="monospace" size="sm" style={{ wordBreak: 'break-all' }}>
								{shownPlaintext ?? ''}
							</Text>
							<CopyButton value={shownPlaintext ?? ''} timeout={1500}>
								{({ copied, copy }) => (
									<Tooltip label={copied ? t('donate.copied') : t('donate.copy')}>
										<ActionIcon color={copied ? 'green' : 'gray'} variant="filled" onClick={copy}>
											{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
										</ActionIcon>
									</Tooltip>
								)}
							</CopyButton>
						</Group>
					</Card>
					<Text size="sm" c="dimmed">
						{t('api_keys.usage_hint')}
					</Text>
					<Card withBorder p="sm">
						<Text size="xs" ff="monospace">
							curl -H "Authorization: Bearer {shownPlaintext ?? '...'}" \<br />
							&nbsp;&nbsp;https://&lt;your-cloudgate&gt;/api/hosts
						</Text>
					</Card>
				</Stack>
			</Modal>
		</Stack>
	);
}
