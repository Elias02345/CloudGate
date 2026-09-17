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
	Box,
	Card,
	Flex,
	Group,
	Modal,
	SimpleGrid,
	Stack,
	Text,
	Title,
	UnstyledButton,
	useComputedColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
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
import { CopyButton } from '../components/CopyButton.js';
import { Tooltip } from '../components/Tooltip.js';

interface DonationOption {
	key: string;
	label: string;
	icon: React.ReactNode;
	/** Icon colour, or a light/dark pair for brand colours that don't read on both schemes. */
	color: string | { light: string; dark: string };
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
		// Brand blue #003087 is nearly invisible on the dark background; use PayPal's lighter blue there.
		color: { dark: '#009cde', light: '#003087' },
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

			<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mt="sm" data-tour="donate-cards">
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
	const scheme = useComputedColorScheme('dark');
	const [qrOpened, qrModal] = useDisclosure(false);
	const iconColor = typeof option.color === 'string' ? option.color : option.color[scheme];

	return (
		<Card withBorder radius="md" padding="lg">
			<Stack gap="sm">
				<Group justify="space-between" wrap="wrap" gap="sm">
					<Group gap="xs">
						<Box style={{ color: iconColor }}>{option.icon}</Box>
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

				{/* Phones: QR above the address so the address gets the full card width */}
				<Flex direction={{ base: 'column', sm: 'row' }} align={{ base: 'center', sm: 'flex-start' }} gap="md">
					{/* QR code — click to enlarge */}
					<UnstyledButton
						onClick={qrModal.open}
						title={t('donate.enlarge_qr', { label: option.label })}
						aria-label={t('donate.enlarge_qr', { label: option.label })}
						style={{
							background: 'white',
							padding: 8,
							borderRadius: 'var(--mantine-radius-sm)',
							lineHeight: 0,
							flexShrink: 0,
							cursor: 'pointer',
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
					</UnstyledButton>

					{/* Address + copy */}
					<Stack gap={6} w={{ base: '100%', sm: 'auto' }} style={{ flex: 1, minWidth: 0 }}>
						{/* Copy button sits next to the label, not the value: a long wrapped
						    address then gets the full card width with nothing beside it to
						    crowd into. */}
						<Group gap={4} justify="space-between" wrap="nowrap">
							<Text size="xs" c="dimmed">
								{option.externalLink ? t('donate.label_link') : t('donate.label_address')}
							</Text>
							<CopyButton value={option.addressOrUrl} timeout={1500}>
								{({ copied, copy }) => (
									<Tooltip label={copied ? t('donate.copied') : t('donate.copy')}>
										<ActionIcon
											color={copied ? 'green' : 'gray'}
											variant="subtle"
											size="sm"
											onClick={copy}
											aria-label={t('donate.copy')}
										>
											{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
										</ActionIcon>
									</Tooltip>
								)}
							</CopyButton>
						</Group>
						<Text
							size="xs"
							ff="monospace"
							style={{
								wordBreak: 'break-all',
								overflowWrap: 'anywhere',
							}}
						>
							{option.addressOrUrl}
						</Text>
						{option.hint && (
							<Text size="xs" c="dimmed">
								{t(`donate.${option.hint}`)}
							</Text>
						)}
					</Stack>
				</Flex>
			</Stack>

			<Modal
				opened={qrOpened}
				onClose={qrModal.close}
				centered
				withCloseButton={false}
				padding={0}
				overlayProps={{ backgroundOpacity: 0.55, blur: 8 }}
				styles={{ content: { background: 'transparent', boxShadow: 'none' }, body: { padding: 0 } }}
			>
				{/* Click anywhere in the overlay content to close */}
				<UnstyledButton
					onClick={qrModal.close}
					style={{ display: 'block', width: '100%', cursor: 'pointer' }}
					aria-label={t('donate.close_qr')}
				>
					<Stack align="center" gap="sm" py="xl">
						<Box
							style={{
								background: 'white',
								padding: 16,
								borderRadius: 'var(--mantine-radius-lg)',
								lineHeight: 0,
							}}
						>
							<QRCodeSVG
								value={option.qrPayload}
								size={320}
								style={{ width: 'min(320px, 70vw)', height: 'min(320px, 70vw)' }}
								level="M"
								marginSize={0}
								bgColor="#ffffff"
								fgColor="#000000"
							/>
						</Box>
						<Text fw={600} c="white">
							{option.label}
						</Text>
						<Text
							size="sm"
							ff="monospace"
							c="white"
							ta="center"
							maw="min(320px, 70vw)"
							style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}
						>
							{option.addressOrUrl}
						</Text>
					</Stack>
				</UnstyledButton>
			</Modal>
		</Card>
	);
}
