/**
 * Support / Donate page.
 *
 * Four cards: PayPal (link + QR), Bitcoin / Ethereum / Solana (address +
 * copy-to-clipboard + QR). QR encodes BIP21-style URIs where possible so
 * mobile wallets pre-fill the destination.
 */

import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Card,
	CopyButton,
	Group,
	SimpleGrid,
	Stack,
	Text,
	Title,
	Tooltip,
} from '@mantine/core';
import {
	IconBrandPaypal,
	IconCheck,
	IconCopy,
	IconCurrencyBitcoin,
	IconCurrencyEthereum,
	IconCurrencySolana,
	IconExternalLink,
	IconHeartFilled,
} from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';

interface DonationOption {
	key: string;
	label: string;
	icon: React.ReactNode;
	color: string;
	addressOrUrl: string;
	displayAddress?: string;
	qrPayload: string;
	hint?: string;
	externalLink?: string;
}

const OPTIONS: DonationOption[] = [
	{
		key: 'paypal',
		label: 'PayPal',
		icon: <IconBrandPaypal size={28} />,
		color: '#003087',
		addressOrUrl: 'https://www.paypal.me/EliasK09',
		qrPayload: 'https://www.paypal.me/EliasK09',
		externalLink: 'https://www.paypal.me/EliasK09',
		hint: 'paypal_hint',
	},
	{
		key: 'btc',
		label: 'Bitcoin',
		icon: <IconCurrencyBitcoin size={28} />,
		color: '#f7931a',
		addressOrUrl: 'bc1qphk3h7sw6j429c62ypw6zxgmkfeevmxs437ze3',
		qrPayload: 'bitcoin:bc1qphk3h7sw6j429c62ypw6zxgmkfeevmxs437ze3',
		hint: 'btc_hint',
	},
	{
		key: 'eth',
		label: 'Ethereum',
		icon: <IconCurrencyEthereum size={28} />,
		color: '#627eea',
		addressOrUrl: '0x81deF905D66fd17433003e749f1e69bCFd95664d',
		qrPayload: 'ethereum:0x81deF905D66fd17433003e749f1e69bCFd95664d',
		hint: 'eth_hint',
	},
	{
		key: 'sol',
		label: 'Solana',
		icon: <IconCurrencySolana size={28} />,
		color: '#9945ff',
		addressOrUrl: 'G362aMnx7jSXp4iWtCwyw2yXy52ukRVoFgYCpw4aqrPQ',
		qrPayload: 'solana:G362aMnx7jSXp4iWtCwyw2yXy52ukRVoFgYCpw4aqrPQ',
		hint: 'sol_hint',
	},
];

export function DonatePage() {
	const { t } = useTranslation();

	return (
		<Stack maw={920} mx="auto">
			<Group>
				<IconHeartFilled size={28} color="#ff6620" />
				<Title order={2}>{t('donate.title')}</Title>
			</Group>
			<Text c="dimmed" maw={700}>
				{t('donate.intro')}
			</Text>
			<Text size="sm" c="dimmed" maw={700}>
				{t('donate.thanks')}
			</Text>

			<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mt="sm">
				{OPTIONS.map((opt) => (
					<DonationCard key={opt.key} option={opt} />
				))}
			</SimpleGrid>

			<Card withBorder mt="md">
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{t('donate.alternative_title')}
					</Text>
					<Text size="sm" c="dimmed">
						{t('donate.alternative_body')}
					</Text>
					<Group>
						<Anchor href="https://github.com/Elias02345/CloudGate" target="_blank" rel="noreferrer">
							⭐ {t('donate.github_star')}
						</Anchor>
						<Anchor href="https://github.com/Elias02345/CloudGate/issues" target="_blank" rel="noreferrer">
							🐛 {t('donate.report_bug')}
						</Anchor>
					</Group>
				</Stack>
			</Card>
		</Stack>
	);
}

function DonationCard({ option }: { option: DonationOption }) {
	const { t } = useTranslation();

	return (
		<Card withBorder radius="md" padding="lg">
			<Stack gap="sm">
				<Group justify="space-between">
					<Group gap="xs">
						<Box style={{ color: option.color }}>{option.icon}</Box>
						<Text fw={600} size="lg">
							{option.label}
						</Text>
					</Group>
					{option.externalLink && (
						<Anchor href={option.externalLink} target="_blank" rel="noreferrer">
							<IconExternalLink size={16} />
						</Anchor>
					)}
				</Group>

				<Group align="flex-start" wrap="nowrap">
					{/* QR code */}
					<Box
						style={{
							background: 'white',
							padding: 8,
							borderRadius: 6,
							lineHeight: 0,
							flexShrink: 0,
						}}
					>
						<QRCodeSVG
							value={option.qrPayload}
							size={120}
							level="M"
							marginSize={0}
							bgColor="#ffffff"
							fgColor="#000000"
						/>
					</Box>

					{/* Address + copy */}
					<Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
						<Text size="xs" c="dimmed">
							{option.externalLink ? t('donate.label_link') : t('donate.label_address')}
						</Text>
						<Group gap={4} wrap="nowrap">
							<Text
								size="xs"
								ff="monospace"
								style={{
									flex: 1,
									wordBreak: 'break-all',
									overflowWrap: 'anywhere',
								}}
							>
								{option.addressOrUrl}
							</Text>
							<CopyButton value={option.addressOrUrl} timeout={1500}>
								{({ copied, copy }) => (
									<Tooltip label={copied ? t('donate.copied') : t('donate.copy')}>
										<ActionIcon
											color={copied ? 'green' : 'gray'}
											variant="subtle"
											onClick={copy}
											aria-label={t('donate.copy')}
										>
											{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
										</ActionIcon>
									</Tooltip>
								)}
							</CopyButton>
						</Group>
						{option.hint && (
							<Text size="xs" c="dimmed">
								{t(`donate.${option.hint}`)}
							</Text>
						)}
						{option.externalLink && (
							<Badge color="cg-orange" variant="light" size="sm" mt={4}>
								{t('donate.one_click')}
							</Badge>
						)}
					</Stack>
				</Group>
			</Stack>
		</Card>
	);
}
