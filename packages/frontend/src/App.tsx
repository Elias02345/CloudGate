import { ActionIcon, AppShell, Group, Menu, Text, Title } from '@mantine/core';
import { IconCloudComputing, IconLogout, IconUser } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from './api/auth.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { PasswordChangePage } from './pages/PasswordChangePage.js';

export function App() {
	const { t } = useTranslation();
	const { data: me } = useMe();
	const logout = useLogout();
	const navigate = useNavigate();

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
					{me?.user && (
						<Menu shadow="md" position="bottom-end">
							<Menu.Target>
								<ActionIcon variant="subtle" size="lg" aria-label={t('header.user_menu')}>
									<IconUser size={18} />
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Label>{me.user.email}</Menu.Label>
								<Menu.Divider />
								<Menu.Item
									leftSection={<IconLogout size={16} />}
									onClick={async () => {
										await logout.mutateAsync();
										navigate('/login', { replace: true });
									}}
								>
									{t('header.logout')}
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					)}
				</Group>
			</AppShell.Header>
			<AppShell.Main>
				<Routes>
					<Route path="/login" element={<LoginPage />} />
					<Route
						path="/password"
						element={
							<ProtectedRoute enforcePasswordSet={false}>
								<PasswordChangePage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/"
						element={
							<ProtectedRoute>
								<DashboardPage />
							</ProtectedRoute>
						}
					/>
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
			</AppShell.Main>
		</AppShell>
	);
}
