import { Alert, Button, Card, Code, Stack, Title } from '@mantine/core';
import { IconAlertCircle, IconRefresh } from '@tabler/icons-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
	children: ReactNode;
}

interface State {
	error: Error | null;
	info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null, info: null };

	static getDerivedStateFromError(error: Error): State {
		return { error, info: null };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		this.setState({ error, info });
		// eslint-disable-next-line no-console
		console.error('UI crashed:', error, info);
	}

	override render(): ReactNode {
		if (!this.state.error) return this.props.children;

		return (
			<div style={{ padding: 32, maxWidth: 720, margin: '40px auto' }}>
				<Card withBorder shadow="md">
					<Stack>
						<Title order={3}>
							<IconAlertCircle size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />
							CloudGate UI crashed
						</Title>
						<Alert color="red" title="Don't panic">
							Your CloudGate data is not affected — this is only a frontend rendering error.
							Reload the page to recover.
						</Alert>
						<Code block>{String(this.state.error?.stack ?? this.state.error?.message ?? 'unknown')}</Code>
						<Button leftSection={<IconRefresh size={16} />} onClick={() => window.location.reload()}>
							Reload page
						</Button>
					</Stack>
				</Card>
			</div>
		);
	}
}
