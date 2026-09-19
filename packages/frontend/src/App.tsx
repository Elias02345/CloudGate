import { ActionIcon, AppShell, Burger, Group, Menu, NavLink, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
	IconArrowUp,
	IconBook,
	IconClipboardList,
	IconCloudCheck,
	IconCloudComputing,
	IconDatabaseExport,
	IconDeviceGamepad2,
	IconHeart,
	IconHome,
	IconKey,
	IconLogout,
	IconRobot,
	IconRoute,
	IconServer2,
	IconSettings,
	IconUser,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from './api/auth.js';
import { UNAUTHORIZED_EVENT } from './api/client.js';
import { useEventStream } from './api/events.js';
import { AiChatFab } from './components/AiChat.js';
import { AppTourProvider } from './components/AppTour.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { CloudyStage } from './components/cloudy/CloudyStage.js';
import { CloudyProvider } from './components/cloudy/useCloudy.js';
import { AiSettingsPage } from './pages/AiSettingsPage.js';
import { ApiDocsPage } from './pages/ApiDocsPage.js';
import { ApiKeysPage } from './pages/ApiKeysPage.js';
import { AuditLogPage } from './pages/AuditLogPage.js';
import { BackupPage } from './pages/BackupPage.js';
import { CloudflarePage } from './pages/CloudflarePage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DonatePage } from './pages/DonatePage.js';
import { HostFormPage } from './pages/HostFormPage.js';
import { HostsPage } from './pages/HostsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { PasswordChangePage } from './pages/PasswordChangePage.js';
import { PlayitPage } from './pages/PlayitPage.js';
import { RestorePage } from './pages/RestorePage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TunnelsPage } from './pages/TunnelsPage.js';
import { UpdatesPage } from './pages/UpdatesPage.js';

export function App() {
	const { t } = useTranslation();
	const { data: me } = useMe();
	const logout = useLogout();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();

	const [navOpened, nav] = useDisclosure(false);

	const showShell = !!me?.user && !me.user.must_change_password;

	// Close the mobile nav drawer after picking a page
	const go = (path: string) => {
		navigate(path);
		nav.close();
	};

	// Subscribe to backend events for live query invalidation
	useEventStream();

	// The session ended somewhere — an expired token, a password change in
	// another tab, a restarted backend. api() has already dropped the token;
	// re-reading /auth/me is what makes ProtectedRoute notice and send the
	// user to the login page, instead of leaving them on a screen whose data
	// can no longer refresh.
	useEffect(() => {
		const onUnauthorized = () => {
			void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
		};
		window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
		return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
	}, [queryClient]);

	return (
		<CloudyProvider>
			<AppTourProvider>
				<AppShell
					header={{ height: 56 }}
					navbar={showShell ? { width: 220, breakpoint: 'sm', collapsed: { mobile: !navOpened } } : undefined}
					padding="md"
					withBorder={false}
				>
					<AppShell.Header>
						<Group h="100%" px="md" justify="space-between" wrap="nowrap">
							<Group gap="xs" wrap="nowrap" data-tour="app-logo">
								{showShell && (
									<Burger
										opened={navOpened}
										onClick={nav.toggle}
										hiddenFrom="sm"
										size="sm"
										aria-label={t('header.toggle_nav')}
										data-tour="nav-burger"
									/>
								)}
								<IconCloudComputing size={26} style={{ color: 'var(--cg-accent-logo)' }} />
								<Title order={3}>CloudGate</Title>
								<Text size="xs" c="dimmed" visibleFrom="xs">
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
									onClick={() => go('/')}
								/>
								<NavLink
									label={t('nav.cloudflare')}
									leftSection={<IconCloudCheck size={16} />}
									active={location.pathname.startsWith('/cloudflare')}
									onClick={() => go('/cloudflare')}
								/>
								<NavLink
									label="Playit"
									leftSection={<IconDeviceGamepad2 size={16} />}
									active={location.pathname.startsWith('/playit')}
									onClick={() => go('/playit')}
								/>
								<NavLink
									label={t('nav.tunnels')}
									leftSection={<IconRoute size={16} />}
									active={location.pathname.startsWith('/tunnels')}
									onClick={() => go('/tunnels')}
								/>
								<NavLink
									label={t('nav.hosts')}
									leftSection={<IconServer2 size={16} />}
									active={location.pathname.startsWith('/hosts')}
									onClick={() => go('/hosts')}
								/>
								<NavLink
									label={t('nav.audit')}
									leftSection={<IconClipboardList size={16} />}
									active={location.pathname.startsWith('/audit')}
									onClick={() => go('/audit')}
								/>
								<NavLink
									label={t('nav.updates')}
									leftSection={<IconArrowUp size={16} />}
									active={location.pathname.startsWith('/updates')}
									onClick={() => go('/updates')}
								/>
								<NavLink
									label={t('nav.settings')}
									leftSection={<IconSettings size={16} />}
									active={location.pathname.startsWith('/settings')}
									onClick={() => go('/settings')}
								/>
								<NavLink
									label="Backup"
									leftSection={<IconDatabaseExport size={16} />}
									active={location.pathname.startsWith('/backup')}
									onClick={() => go('/backup')}
								/>
								<NavLink
									label={t('nav.api_keys')}
									leftSection={<IconKey size={16} />}
									active={location.pathname.startsWith('/api-keys')}
									onClick={() => go('/api-keys')}
								/>
								<NavLink
									label={t('nav.api_docs')}
									leftSection={<IconBook size={16} />}
									active={location.pathname.startsWith('/api-docs')}
									onClick={() => go('/api-docs')}
								/>
								<NavLink
									label={t('nav.ai')}
									leftSection={<IconRobot size={16} style={{ color: 'var(--cg-accent-ai)' }} />}
									active={location.pathname.startsWith('/ai')}
									onClick={() => go('/ai')}
								/>
								<NavLink
									label={t('nav.donate')}
									leftSection={<IconHeart size={16} color="#ff6620" />}
									active={location.pathname.startsWith('/donate')}
									onClick={() => go('/donate')}
								/>
							</Stack>
						</AppShell.Navbar>
					)}

					{/*
					 * Keyed on the path so React remounts the wrapper on every
					 * navigation, which restarts the enter animation. Without the
					 * key the class is already applied and the animation never
					 * replays. Kept to a short fade with a few pixels of travel:
					 * this runs on every click in the sidebar, and anything
					 * longer turns routine navigation into waiting.
					 */}
					<AppShell.Main key={location.pathname} className="cg-page">
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
								path="/playit"
								element={
									<ProtectedRoute>
										<PlayitPage />
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
								path="/backup"
								element={
									<ProtectedRoute>
										<BackupPage />
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
							<Route
								path="/api-keys"
								element={
									<ProtectedRoute>
										<ApiKeysPage />
									</ProtectedRoute>
								}
							/>
							<Route
								path="/api-docs"
								element={
									<ProtectedRoute>
										<ApiDocsPage />
									</ProtectedRoute>
								}
							/>
							<Route
								path="/ai"
								element={
									<ProtectedRoute>
										<AiSettingsPage />
									</ProtectedRoute>
								}
							/>
							<Route path="*" element={<Navigate to="/" replace />} />
						</Routes>
					</AppShell.Main>
					{showShell && <AiChatFab />}
				</AppShell>
				{showShell && <CloudyStage />}
			</AppTourProvider>
		</CloudyProvider>
	);
}
