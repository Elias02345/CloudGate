import { AppShell, Group, Text, Title } from '@mantine/core';
import { IconCloudComputing } from '@tabler/icons-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';

export function App() {
	return (
		<AppShell header={{ height: 56 }} padding="md">
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between">
					<Group gap="xs">
						<IconCloudComputing size={26} color="#ff9966" />
						<Title order={3}>CloudGate</Title>
						<Text size="xs" c="dimmed">
							pre-alpha
						</Text>
					</Group>
				</Group>
			</AppShell.Header>
			<AppShell.Main>
				<Routes>
					<Route path="/login" element={<LoginPage />} />
					<Route path="/" element={<DashboardPage />} />
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
			</AppShell.Main>
		</AppShell>
	);
}
