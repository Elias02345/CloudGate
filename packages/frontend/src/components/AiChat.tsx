/**
 * Floating chat drawer for the CloudGate AI assistant.
 *
 * - FAB bottom-left, only visible when settings.autonomy !== 'off'.
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
	Box,
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
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconSend, IconSparkles } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
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
import { MOBILE_QUERY } from '../layout.js';
import { useConfirm } from './ConfirmProvider.js';
import { Tooltip } from './Tooltip.js';
import { Cloudy } from './cloudy/Cloudy.js';
import { targetForTool } from './cloudy/targets.js';
import { useCloudy } from './cloudy/useCloudy.js';

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
			<Affix position={{ bottom: 32, left: 40 }}>
				<Tooltip label={t('ai_chat.open')}>
					<ActionIcon
						size="xl"
						radius={18}
						color="cyan"
						variant="filled"
						onClick={drawer.open}
						aria-label={t('ai_chat.open')}
					>
						{/* Cloudy is the assistant — his face is the button */}
						<Cloudy size={30} pose="idle" />
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
	const confirm = useConfirm();
	const isMobile = useMediaQuery(MOBILE_QUERY) ?? false;
	const [conversationId, setConversationId] = useState<string | null>(null);
	const conversations = useConversations();
	const conversation = useConversation(conversationId);
	const sendMessage = useSendMessage();
	const confirmAction = useConfirmAction();
	const deleteConv = useDeleteConversation();
	const [pendingMessage, setPendingMessage] = useState('');
	const cloudy = useCloudy();
	const navigate = useNavigate();
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll on new messages. The message count is a trigger, not a value the body
	// reads: dropping it (as the rule suggests) would scroll once on mount and never again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: message count is a re-run trigger
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [conversation.data?.messages.length]);

	/**
	 * Cloudy steps out of the chat and walks to whatever the assistant touched:
	 * one stop per tool it used, working there, then a cheer and back home.
	 */
	const showWork = async (tools: string[]) => {
		// Out of the way: the whole point is watching him do it
		onClose();
		await cloudy.say(t('cloudy.on_my_way'), { ms: 900 });
		for (const tool of tools) {
			const target = targetForTool(tool);
			if (!target) continue;
			navigate(target.route);
			await cloudy.walkTo(target.selector, { say: t('cloudy.working') });
			await cloudy.setPose('work', { ms: 1400 });
		}
		await cloudy.setPose('cheer', { ms: 900 });
		await cloudy.say(t('cloudy.done'), { ms: 1200 });
		await cloudy.goHome();
	};

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
			const tools = [...new Set((result.tool_results ?? []).map((r) => r.name))];
			if (tools.length > 0) void showWork(tools);
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
		if (
			!(await confirm({
				title: t('ai_chat.delete_title'),
				message: t('ai_chat.confirm_delete'),
				confirmLabel: t('common.delete'),
				danger: true,
			}))
		)
			return;
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
		<Drawer
			opened={opened}
			onClose={onClose}
			position={isMobile ? 'bottom' : 'right'}
			size={isMobile ? '92%' : 'md'}
			withCloseButton={false}
			padding={0}
			// The drawer body has to carry the height, otherwise the input row floats
			// under the messages instead of sitting at the bottom edge
			styles={{
				content: {
					display: 'flex',
					flexDirection: 'column',
					...(isMobile ? { borderRadius: 'var(--mantine-radius-md) var(--mantine-radius-md) 0 0' } : {}),
				},
				body: { flex: 1, minHeight: 0 },
			}}
		>
			<Stack gap={0} h="100%">
				{/* Header */}
				<Group
					justify="space-between"
					px="md"
					py="sm"
					wrap="nowrap"
					style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
				>
					<Group gap="xs" wrap="nowrap">
						<Cloudy size={22} pose="idle" />
						<Text fw={600}>{t('ai_chat.title')}</Text>
					</Group>
					<Group gap="xs" wrap="nowrap">
						<Tooltip label={t('ai_chat.new_conversation')}>
							<ActionIcon
								variant="subtle"
								onClick={onNewConversation}
								aria-label={t('ai_chat.new_conversation')}
							>
								<IconSparkles size={16} />
							</ActionIcon>
						</Tooltip>
						<CloseButton onClick={onClose} aria-label={t('common.close')} />
					</Group>
				</Group>

				{/* Conversation picker */}
				<Group px="md" py="xs" gap="xs" wrap="nowrap">
					<Select
						placeholder={t('ai_chat.pick_conversation')}
						size="xs"
						style={{ flex: 1, minWidth: 0 }}
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
						<Button
							size="xs"
							variant="subtle"
							color="red"
							onClick={onDeleteConversation}
							style={{ flexShrink: 0 }}
						>
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
									<Cloudy size={18} pose="idle" />
								</Avatar>
								<Loader size="xs" type="dots" />
							</Group>
						)}
					</Stack>
				</ScrollArea>

				{/* Input */}
				<Stack
					px="md"
					py="sm"
					gap="xs"
					style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
				>
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
				// scheme-neutral tinted surface (same recipe as Badge/Alert's yellow "light" variant)
				<Card withBorder p="sm" style={{ backgroundColor: 'var(--mantine-color-yellow-light)' }}>
					<Stack gap="xs">
						<Group gap="xs">
							<IconAlertTriangle size={16} style={{ color: 'var(--cg-accent-warn)' }} />
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

	if (role === 'user') {
		return (
			<Group justify="flex-end">
				<Box
					maw="80%"
					px="sm"
					py="xs"
					style={{
						backgroundColor: 'var(--mantine-primary-color-light)',
						borderRadius: 'var(--mantine-radius-md)',
					}}
				>
					<Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
						{content}
					</Text>
				</Box>
			</Group>
		);
	}

	return (
		<Group align="flex-start" gap="xs" wrap="nowrap">
			<Avatar size="sm" color="cyan" radius="xl">
				<Cloudy size={16} pose="idle" />
			</Avatar>
			<Card withBorder p="xs" style={{ flex: 1, minWidth: 0 }}>
				<div className="ai-markdown" style={{ overflowWrap: 'anywhere' }}>
					<ReactMarkdown
						remarkPlugins={[remarkGfm]}
						components={{
							pre: (props) => <pre {...props} style={{ overflowX: 'auto', maxWidth: '100%' }} />,
						}}
					>
						{content || ''}
					</ReactMarkdown>
				</div>
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
