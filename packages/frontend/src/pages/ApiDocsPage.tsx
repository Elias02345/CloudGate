/**
 * /api-docs — lightweight rendering of the OpenAPI spec.
 *
 * We don't pull in swagger-ui-react (~2MB) for a homelab tool. Instead we
 * fetch the spec ourselves and render a readable list of endpoints with a
 * link to the JSON for proper tools (Insomnia, Postman, agent code).
 */

import { Anchor, Badge, Card, Code, Group, Stack, Text, Title } from '@mantine/core';
import { IconBook, IconDownload, IconExternalLink } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

interface OpenApiSpec {
	info: { title: string; version: string; description?: string };
	tags: Array<{ name: string; description?: string }>;
	paths: Record<string, Record<string, { tags?: string[]; summary?: string; description?: string }>>;
}

const HTTP_COLOURS: Record<string, string> = {
	get: 'blue',
	post: 'green',
	put: 'orange',
	delete: 'red',
	patch: 'cyan',
};

export function ApiDocsPage() {
	const { t } = useTranslation();
	const spec = useQuery<OpenApiSpec>({
		queryKey: ['openapi'],
		queryFn: async () => {
			const res = await fetch('/api/openapi.json');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		},
		staleTime: 5 * 60_000,
	});

	if (spec.isLoading) {
		return <Text c="dimmed">{t('common.loading')}</Text>;
	}
	if (spec.isError || !spec.data) {
		return <Text c="red">Failed to load OpenAPI spec.</Text>;
	}

	// Group endpoints by tag
	const grouped = new Map<
		string,
		Array<{ path: string; method: string; op: { summary?: string; description?: string } }>
	>();
	for (const [path, methods] of Object.entries(spec.data.paths)) {
		for (const [method, op] of Object.entries(methods)) {
			if (typeof op !== 'object' || op === null || !('summary' in op || 'tags' in op)) continue;
			const tag = (op as { tags?: string[] }).tags?.[0] ?? 'other';
			if (!grouped.has(tag)) grouped.set(tag, []);
			grouped
				.get(tag)!
				.push({ path, method: method.toUpperCase(), op: op as { summary?: string; description?: string } });
		}
	}

	const tagOrder = spec.data.tags.map((tg) => tg.name);
	const sortedTags = Array.from(grouped.keys()).sort((a, b) => {
		const ai = tagOrder.indexOf(a);
		const bi = tagOrder.indexOf(b);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
	});

	return (
		<Stack maw={1000} mx="auto">
			<Group>
				<IconBook size={26} color="#22d3ee" />
				<Title order={2}>{spec.data.info.title}</Title>
				<Badge variant="light">v{spec.data.info.version}</Badge>
			</Group>
			{spec.data.info.description && (
				<Text c="dimmed" size="sm" style={{ whiteSpace: 'pre-line' }}>
					{spec.data.info.description}
				</Text>
			)}
			<Group gap="md">
				<Anchor href="/api/openapi.json" target="_blank" rel="noreferrer">
					<Group gap={4}>
						<IconDownload size={14} />
						<Text size="sm">{t('api_docs.download_spec')}</Text>
					</Group>
				</Anchor>
				<Anchor
					href="https://github.com/Elias02345/CloudGate/blob/main/docs/AGENT.md"
					target="_blank"
					rel="noreferrer"
				>
					<Group gap={4}>
						<IconExternalLink size={14} />
						<Text size="sm">{t('api_docs.agent_md')}</Text>
					</Group>
				</Anchor>
			</Group>

			{sortedTags.map((tag) => {
				const endpoints = grouped.get(tag) ?? [];
				const tagInfo = spec.data?.tags.find((tg) => tg.name === tag);
				return (
					<Card key={tag} withBorder>
						<Stack gap="xs">
							<Group>
								<Title order={4}>{tag}</Title>
								{tagInfo?.description && (
									<Text size="xs" c="dimmed">
										— {tagInfo.description}
									</Text>
								)}
							</Group>
							<Stack gap={4}>
								{endpoints.map((e) => (
									<Group key={`${e.method}:${e.path}`} gap="sm" wrap="nowrap">
										<Badge color={HTTP_COLOURS[e.method.toLowerCase()] ?? 'gray'} w={70} ta="center">
											{e.method}
										</Badge>
										<Code style={{ flexShrink: 0 }}>{e.path}</Code>
										<Text size="sm" c="dimmed">
											— {e.op.summary ?? ''}
										</Text>
									</Group>
								))}
							</Stack>
						</Stack>
					</Card>
				);
			})}
		</Stack>
	);
}
