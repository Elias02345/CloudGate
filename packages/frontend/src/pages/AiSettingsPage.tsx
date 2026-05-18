/**
 * Configure the optional in-app AI assistant.
 *
 * Provider radio (anthropic / openai / custom), model + optional base URL,
 * API key (write-only), autonomy radio (off / suggest_only / autonomous),
 * optional system-prompt override, "Test connection" button.
 */

import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Card,
	Chip,
	Group,
	PasswordInput,
	Radio,
	Stack,
	Text,
	TextInput,
	Textarea,
	Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconRobot, IconTestPipe } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLlmSettings, useTestLlm, useUpdateLlmSettings } from '../api/ai.js';
import { ApiError } from '../api/client.js';

interface FormValues {
	provider: 'anthropic' | 'openai' | 'custom';
	model: string;
	base_url: string;
	api_key: string;
	autonomy: 'off' | 'suggest_only' | 'autonomous';
	system_prompt_override: string;
}

const MODEL_SUGGESTIONS: Record<FormValues['provider'], string[]> = {
	anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
	openai: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
	custom: ['llama3.2', 'mistral-large', 'qwen2.5-coder'],
};

const DEFAULT_BASE_URLS: Record<FormValues['provider'], string> = {
	anthropic: '',
	openai: 'https://api.openai.com/v1',
	custom: 'https://openrouter.ai/api/v1',
};

export function AiSettingsPage() {
	const { t } = useTranslation();
	const settings = useLlmSettings();
	const update = useUpdateLlmSettings();
	const testConn = useTestLlm();
	const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

	const form = useForm<FormValues>({
		initialValues: {
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			base_url: '',
			api_key: '',
			autonomy: 'off',
			system_prompt_override: '',
		},
	});

	useEffect(() => {
		if (!settings.data) return;
		form.setValues({
			provider: settings.data.provider ?? 'anthropic',
			model: settings.data.model ?? 'claude-sonnet-4-6',
			base_url: settings.data.base_url ?? '',
			api_key: '',
			autonomy: settings.data.autonomy,
			system_prompt_override: settings.data.system_prompt_override ?? '',
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [settings.data]);

	const onSave = form.onSubmit(async (values) => {
		try {
			await update.mutateAsync({
				provider: values.provider,
				model: values.model,
				base_url: values.base_url || null,
				autonomy: values.autonomy,
				system_prompt_override: values.system_prompt_override || null,
				...(values.api_key ? { api_key: values.api_key } : {}),
			});
			form.setFieldValue('api_key', '');
			notifications.show({
				color: 'green',
				icon: <IconCheck size={18} />,
				message: t('ai_settings.saved'),
			});
		} catch (err) {
			notifications.show({
				color: 'red',
				message: err instanceof ApiError ? `${err.message} (${err.code})` : (err as Error).message,
			});
		}
	});

	const onTest = async () => {
		setTestResult(null);
		try {
			const r = await testConn.mutateAsync({
				provider: form.values.provider,
				model: form.values.model,
				base_url: form.values.base_url || null,
				...(form.values.api_key ? { api_key: form.values.api_key } : {}),
			});
			if (r.ok) {
				setTestResult({
					ok: true,
					message: t('ai_settings.test_ok', { ms: r.latency_ms ?? '?', model: r.model ?? form.values.model }),
				});
			} else {
				setTestResult({ ok: false, message: r.error ?? 'Test failed' });
			}
		} catch (err) {
			setTestResult({ ok: false, message: (err as Error).message });
		}
	};

	const hasKey = settings.data?.has_api_key ?? false;

	return (
		<Stack maw={780} mx="auto">
			<Group>
				<IconRobot size={26} color="#22d3ee" />
				<Title order={2}>{t('ai_settings.title')}</Title>
				<Badge variant="light">{t('common.optional' as never, { defaultValue: 'Optional' })}</Badge>
			</Group>
			<Text c="dimmed" size="sm">
				{t('ai_settings.intro')}
			</Text>

			<form onSubmit={onSave}>
				<Stack>
					<Card withBorder>
						<Stack>
							<Title order={4}>{t('ai_settings.provider_section')}</Title>
							<Radio.Group {...form.getInputProps('provider')}>
								<Group mt="xs">
									<Radio value="anthropic" label="Anthropic (Claude)" />
									<Radio value="openai" label="OpenAI" />
									<Radio value="custom" label={t('ai_settings.custom_label')} />
								</Group>
							</Radio.Group>

							<TextInput
								label={t('ai_settings.model_field')}
								description={t('ai_settings.model_hint')}
								{...form.getInputProps('model')}
							/>
							<Group gap={4}>
								{MODEL_SUGGESTIONS[form.values.provider].map((m) => (
									<Chip
										key={m}
										size="xs"
										checked={form.values.model === m}
										onChange={() => form.setFieldValue('model', m)}
									>
										{m}
									</Chip>
								))}
							</Group>

							{form.values.provider === 'custom' && (
								<TextInput
									label={t('ai_settings.base_url_field')}
									description={t('ai_settings.base_url_hint')}
									placeholder={DEFAULT_BASE_URLS.custom}
									{...form.getInputProps('base_url')}
								/>
							)}

							<PasswordInput
								label={t('ai_settings.api_key_field')}
								description={hasKey ? t('ai_settings.api_key_replace_hint') : t('ai_settings.api_key_hint')}
								placeholder={hasKey ? '••••••••' : 'sk-...'}
								{...form.getInputProps('api_key')}
							/>
							<Group>
								<Button
									variant="light"
									leftSection={<IconTestPipe size={16} />}
									onClick={onTest}
									loading={testConn.isPending}
								>
									{t('ai_settings.test_button')}
								</Button>
								{testResult && (
									<Alert color={testResult.ok ? 'green' : 'red'} variant="light" p="xs">
										{testResult.message}
									</Alert>
								)}
							</Group>
						</Stack>
					</Card>

					<Card withBorder>
						<Stack>
							<Title order={4}>{t('ai_settings.autonomy_section')}</Title>
							<Radio.Group {...form.getInputProps('autonomy')}>
								<Stack gap="xs" mt="xs">
									<Radio
										value="off"
										label={t('ai_settings.autonomy_off')}
										description={t('ai_settings.autonomy_off_hint')}
									/>
									<Radio
										value="suggest_only"
										label={t('ai_settings.autonomy_suggest')}
										description={t('ai_settings.autonomy_suggest_hint')}
									/>
									<Radio
										value="autonomous"
										label={t('ai_settings.autonomy_autonomous')}
										description={t('ai_settings.autonomy_autonomous_hint')}
									/>
								</Stack>
							</Radio.Group>
						</Stack>
					</Card>

					<Card withBorder>
						<Stack>
							<Title order={4}>{t('ai_settings.advanced_section')}</Title>
							<Textarea
								label={t('ai_settings.system_prompt_field')}
								description={t('ai_settings.system_prompt_hint')}
								autosize
								minRows={3}
								maxRows={10}
								{...form.getInputProps('system_prompt_override')}
							/>
							<Anchor
								href="https://github.com/Elias02345/CloudGate/blob/main/docs/AGENT.md"
								target="_blank"
								rel="noreferrer"
								size="sm"
							>
								{t('ai_settings.read_agent_md')}
							</Anchor>
						</Stack>
					</Card>

					<Box>
						<Button type="submit" loading={update.isPending}>
							{t('ai_settings.save')}
						</Button>
					</Box>
				</Stack>
			</form>
		</Stack>
	);
}
