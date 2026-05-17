import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { theme } from './theme.js';
import './i18n.js';
import './styles/global.css';

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: 1,
			refetchOnWindowFocus: false,
			staleTime: 30_000,
		},
	},
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root in index.html');

createRoot(rootEl).render(
	<StrictMode>
		<ErrorBoundary>
			<QueryClientProvider client={queryClient}>
				<MantineProvider theme={theme} defaultColorScheme="dark">
					<Notifications position="top-right" />
					<BrowserRouter>
						<App />
					</BrowserRouter>
				</MantineProvider>
			</QueryClientProvider>
		</ErrorBoundary>
	</StrictMode>
);
