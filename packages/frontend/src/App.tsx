import { ActionIcon, AppShell, Group, Menu, NavLink, Stack, Text, Title } from '@mantine/core';
import {
	IconArrowUp,
	IconClipboardList,
	IconCloudCheck,
	IconCloudComputing,
	IconHeart,
	IconHome,
	IconLogout,
	IconRoute,
	IconServer2,
	IconSettings,
	IconUser,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from './api/auth.js';
import { useEventStream } from './api/events.js';
import { AppTourProvider } from './components/AppTour.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { AuditLogPage } from './pages/AuditLogPage.js';
import { CloudflarePage } from './pages/CloudflarePage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DonatePage } from './pages/DonatePage.js';
import { HostFormPage } from './pages/HostFormPage.js';
import { HostsPage } from './pages/HostsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { PasswordChangePage } from './pages/PasswordChangePage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { RestorePage } from './pages/RestorePage.js';
import { TunnelsPage } from './pages/TunnelsPage.js';
import { UpdatesPage } from './pages/UpdatesPage.js';

export function App() {
	const { t } = useTranslation();
	const { data: me } = useMe();
	const logout = useLogout();
	const navigate = useNavigate();
	const location = useLocation();

	const showShell = !!me?.user && !me.user.must_change_password;

	// Subscribe to backend events for live query invalidation
	useEventStream();

	return (
		<AppTourProvider>
		<AppShell
			header={{ height: 56 }}
			navbar={showShell ? { width: 220, breakpoint: 'sm' } : undefined}
			padding="md"
		>
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between">
					<Group gap="xs" data-tour="app-logo">
						<IconCloudComputing size={26} color="#ff9966" />
						<Title order={3}>CloudGate</Title>
						<Text size="xs" c="dimmed">
							pre-alpha
						</Text>
					</Group>
					{me?.user && (
						<Group gap="sm">
							<UpdateBanner />
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
						</Group>
					)}
				</Group>
			</AppShell.Header>

			{showShell && (
				<AppShell.Navbar p="xs">
					<Stack gap={4} data-tour="sidebar-nav">
						<NavLink
							label={t('nav.dashboard')}
							leftSection={<IconHome size={16} />}
							active={location.pathname === '/'}
							onClick={() => navigate('/')}
						/>
						<NavLink
							label={t('nav.cloudflare')}
							leftSection={<IconCloudCheck size={16} />}
							active={location.pathname.startsWith('/cloudflare')}
							onClick={() => navigate('/cloudflare')}
						/>
						<NavLink
							label={t('nav.tunnels')}
							leftSection={<IconRoute size={16} />}
							active={location.pathname.startsWith('/tunnels')}
							onClick={() => navigate('/tunnels')}
						/>
						<NavLink
							label={t('nav.hosts')}
							leftSection={<IconServer2 size={16} />}
							active={location.pathname.startsWith('/hosts')}
							onClick={() => navigate('/hosts')}
						/>
						<NavLink
							label={t('nav.audit')}
							leftSection={<IconClipboardList size={16} />}
							active={location.pathname.startsWith('/audit')}
							onClick={() => navigate('/audit')}
						/>
						<NavLink
							label={t('nav.updates')}
							leftSection={<IconArrowUp size={16} />}
							active={location.pathname.startsWith('/updates')}
							onClick={() => navigate('/updates')}
						/>
						<NavLink
							label={t('nav.settings')}
							leftSection={<IconSettings size={16} />}
							active={location.pathname.startsWith('/settings')}
							onClick={() => navigate('/settings')}
						/>
						<NavLink
							label={t('nav.donate')}
							leftSection={<IconHeart size={16} color="#ff6620" />}
							active={location.pathname.startsWith('/donate')}
							onClick={() => navigate('/donate')}
						/>
					</Stack>
				</AppShell.Navbar>
			)}

			<AppShell.Main>
				<Routes>
					<Route path="/login" element={<LoginPage />} />
					<Route path="/restore" element={<RestorePage />} />
					<Route
						path="/onboarding"
						element={
							<ProtectedRoute>
								<OnboardingPage />
							</ProtectedRoute>
						}
					/>
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
					<Route
						path="/cloudflare"
						element={
							<ProtectedRoute>
								<CloudflarePage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/tunnels"
						element={
							<ProtectedRoute>
								<TunnelsPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/hosts"
						element={
							<ProtectedRoute>
								<HostsPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/hosts/new"
						element={
							<ProtectedRoute>
								<HostFormPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/settings"
						element={
							<ProtectedRoute>
								<SettingsPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/audit"
						element={
							<ProtectedRoute>
								<AuditLogPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/updates"
						element={
							<ProtectedRoute>
								<UpdatesPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/donate"
						element={
							<ProtectedRoute>
								<DonatePage />
							</ProtectedRoute>
						}
					/>
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
			</AppShell.Main>
		</AppShell>
		</AppTourProvider>
	);
}
