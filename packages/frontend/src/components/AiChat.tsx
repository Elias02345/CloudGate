/**
 * Floating chat drawer for the CloudGate AI assistant.
 *
 * - FAB bottom-right, only visible when settings.autonomy !== 'off'.
 * - Drawer hosts a conversation: user/assistant bubbles, Markdown rendering
 *   for assistant turns, inline action-confirmation cards in suggest_only
 *   mode.
 */

import {
	ActionIcon,
	Affix,
	Alert,
	Avatar,
	Badge,
	Button,
	Card,
	CloseButton,
	Drawer,
	Group,
	Loader,
	ScrollArea,
	Select,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
	IconAlertTriangle,
	IconMessageChatbot,
	IconRobot,
	IconSend,
	IconSparkles,
	IconUser,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
	useConfirmAction,
	useConversation,
	useConversations,
	useDeleteConversation,
	useLlmSettings,
	useSendMessage,
} from '../api/ai.js';
import { ApiError } from '../api/client.js';

/**
 * App-level mount point — renders the FAB conditionally on enabled state.
 * Drop this into App.tsx near the top-level layout.
 */
export function AiChatFab() {
	const { t } = useTranslation();
	const settings = useLlmSettings();
	const [opened, drawer] = useDisclosure(false);

	if (!settings.data) return null;
	if (settings.data.autonomy === 'off') return null;

	return (
		<>
			<Affix position={{ bottom: 24, right: 24 }}>
				<Tooltip label={t('ai_chat.open')}>
					<ActionIcon
						size="xl"
						radius="xl"
						color="cyan"
						variant="filled"
						onClick={drawer.open}
						aria-label={t('ai_chat.open')}
					>
						<IconMessageChatbot size={26} />
					</ActionIcon>
				</Tooltip>
			</Affix>
			<AiChatDrawer opened={opened} onClose={drawer.close} />
		</>
	);
}

interface AiChatDrawerProps {
	opened: boolean;
	onClose: () => void;
}

function AiChatDrawer({ opened, onClose }: AiChatDrawerProps) {
	const { t } = useTranslation();
	const [conversationId, setConversationId] = useState<string | null>(null);
	const conversations = useConversations();
	const conversation = useConversation(conversationId);
	const sendMessage = useSendMessage();
	const confirmAction = useConfirmAction();
	const deleteConv = useDeleteConversation();
	const [pendingMessage, setPendingMessage] = useState('');
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll on new messages
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [conversation.data?.messages.length]);

	const onSend = async () => {
		const msg = pendingMessage.trim();
		if (!msg) return;
		setPendingMessage('');
		try {
			const result = await sendMessage.mutateAsync({
				message: msg,
				...(conversationId ? { conversation_id: conversationId } : {}),
			});
			if (!conversationId) setConversationId(result.conversation_id);
		} catch (err) {
			notifications.show({
				color: 'red',
				message: err instanceof ApiError ? `${err.message} (${err.code})` : (err as Error).message,
			});
		}
	};

	const onConfirm = async (token: string) => {
		try {
			await confirmAction.mutateAsync({ action_token: token });
			notifications.show({ color: 'green', message: t('ai_chat.action_ok') });
			// Refresh conversation so the user sees their action ran
			if (conversationId) conversation.refetch();
		} catch (err) {
			notifications.show({
				color: 'red',
				message: err instanceof ApiError ? `${err.message} (${err.code})` : (err as Error).message,
			});
		}
	};

	const onNewConversation = () => {
		setConversationId(null);
	};

	const onDeleteConversation = async () => {
		if (!conversationId) return;
		if (!confirm(t('ai_chat.confirm_delete'))) return;
		try {
			await deleteConv.mutateAsync(conversationId);
			setConversationId(null);
			notifications.show({ color: 'green', message: t('ai_chat.deleted') });
		} catch (err) {
			notifications.show({ color: 'red', message: (err as Error).message });
		}
	};

	const messages = conversation.data?.messages ?? [];

	return (
		<Drawer opened={opened} onClose={onClose} position="right" size="md" withCloseButton={false} padding={0}>
			<Stack gap={0} h="100vh">
				{/* Header */}
				<Group
					justify="space-between"
					px="md"
					py="sm"
					style={{ borderBottom: '1px solid var(--mantine-color-gray-3)' }}
				>
					<Group gap="xs">
						<IconRobot size={20} color="#22d3ee" />
						<Text fw={600}>{t('ai_chat.title')}</Text>
					</Group>
					<Group gap="xs">
						<Tooltip label={t('ai_chat.new_conversation')}>
							<ActionIcon variant="subtle" onClick={onNewConversation}>
								<IconSparkles size={16} />
							</ActionIcon>
						</Tooltip>
						<CloseButton onClick={onClose} />
					</Group>
				</Group>

				{/* Conversation picker */}
				<Group px="md" py="xs" gap="xs">
					<Select
						placeholder={t('ai_chat.pick_conversation')}
						size="xs"
						style={{ flex: 1 }}
						value={conversationId}
						onChange={setConversationId}
						data={
							conversations.data?.conversations.map((c) => ({
								value: c.id,
								label: c.title ?? '(untitled)',
							})) ?? []
						}
						clearable
					/>
					{conversationId && (
						<Button size="xs" variant="subtle" color="red" onClick={onDeleteConversation}>
							{t('common.delete')}
						</Button>
					)}
				</Group>

				{/* Messages */}
				<ScrollArea viewportRef={scrollRef} style={{ flex: 1 }} px="md">
					<Stack py="md">
						{!conversationId && messages.length === 0 && (
							<Card withBorder>
								<Stack gap="xs">
									<Text size="sm" fw={600}>
										{t('ai_chat.welcome_title')}
									</Text>
									<Text size="xs" c="dimmed">
										{t('ai_chat.welcome_body')}
									</Text>
									<Text size="xs" c="dimmed">
										{t('ai_chat.example_prompts')}
									</Text>
								</Stack>
							</Card>
						)}
						{messages.map((m) => (
							<MessageBubble
								key={m.id}
								role={m.role}
								content={m.content ?? ''}
								toolCalls={m.tool_calls ?? null}
								toolResults={m.tool_results ?? null}
								onConfirm={onConfirm}
							/>
						))}
						{sendMessage.isPending && (
							<Group gap="xs">
								<Avatar size="sm" color="cyan" radius="xl">
									<IconRobot size={16} />
								</Avatar>
								<Loader size="xs" type="dots" />
							</Group>
						)}
					</Stack>
				</ScrollArea>

				{/* Input */}
				<Stack px="md" py="sm" gap="xs" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
					<Textarea
						placeholder={t('ai_chat.input_placeholder')}
						value={pendingMessage}
						onChange={(e) => setPendingMessage(e.currentTarget.value)}
						autosize
						minRows={1}
						maxRows={4}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								void onSend();
							}
						}}
						disabled={sendMessage.isPending}
					/>
					<Group justify="space-between">
						<Text size="xs" c="dimmed">
							{t('ai_chat.send_hint')}
						</Text>
						<Button
							size="xs"
							leftSection={<IconSend size={14} />}
							onClick={onSend}
							loading={sendMessage.isPending}
							disabled={!pendingMessage.trim()}
						>
							{t('ai_chat.send')}
						</Button>
					</Group>
				</Stack>
			</Stack>
		</Drawer>
	);
}

interface MessageBubbleProps {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls: unknown[] | null;
	toolResults: unknown[] | null;
	onConfirm: (token: string) => void;
}

function MessageBubble({ role, content, toolResults, onConfirm }: MessageBubbleProps) {
	const { t } = useTranslation();
	if (role === 'tool') {
		// Render the tool result if it includes a pending confirmation
		const pending = extractPending(toolResults);
		if (pending) {
			return (
				<Card withBorder p="sm" bg="yellow.0">
					<Stack gap="xs">
						<Group gap="xs">
							<IconAlertTriangle size={16} color="#fbbf24" />
							<Badge color="yellow" variant="light">
								{t('ai_chat.confirm_required')}
							</Badge>
						</Group>
						<Text size="sm">{pending.summary}</Text>
						<Group>
							<Button size="xs" color="cyan" onClick={() => onConfirm(pending.action_token)}>
								{t('ai_chat.run_action')}
							</Button>
						</Group>
					</Stack>
				</Card>
			);
		}
		// Otherwise: silent tool-result message — skip rendering to avoid clutter
		return null;
	}

	const isUser = role === 'user';
	return (
		<Group align="flex-start" gap="xs" wrap="nowrap">
			<Avatar size="sm" color={isUser ? 'gray' : 'cyan'} radius="xl">
				{isUser ? <IconUser size={14} /> : <IconRobot size={14} />}
			</Avatar>
			<Card withBorder p="xs" style={{ flex: 1 }}>
				{isUser ? (
					<Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
						{content}
					</Text>
				) : (
					<div className="ai-markdown">
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{content || ''}</ReactMarkdown>
					</div>
				)}
			</Card>
		</Group>
	);
}

interface PendingPayload {
	action_token: string;
	summary: string;
}

function extractPending(results: unknown[] | null): PendingPayload | null {
	if (!results) return null;
	for (const r of results) {
		const obj = r as { pending?: PendingPayload };
		if (obj?.pending?.action_token && obj.pending.summary) {
			return obj.pending;
		}
	}
	return null;
}

// Re-export for ESLint dead-import cleanups
export { Alert };
