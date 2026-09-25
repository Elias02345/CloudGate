import { Center, Loader, Stack } from '@mantine/core';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMe } from '../api/auth.js';
import { useSetupStatus } from '../api/setup.js';
import { ListError } from './ListError.js';

interface Props {
	children: ReactNode;
	/** When true, redirects to /password if user.must_change_password === true */
	enforcePasswordSet?: boolean;
}

/**
 * Full-screen stand-in for "the backend is not answering".
 *
 * Reuses the same message and retry the list pages show, so an unreachable
 * backend reads the same wherever the user happens to be.
 */
function BackendUnreachable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
	return (
		<Center h="60vh" px="md">
			<Stack maw={520} w="100%">
				<ListError error={error} onRetry={onRetry} />
			</Stack>
		</Center>
	);
}

export function ProtectedRoute({ children, enforcePasswordSet = true }: Props) {
	const { data, isLoading, isError, error, refetch } = useMe();
	const setupStatus = useSetupStatus();
	const location = useLocation();

	if (isLoading || setupStatus.isLoading) {
		return (
			<Center h="60vh">
				<Loader />
			</Center>
		);
	}

	// No admin exists yet — nothing in here is reachable until /setup runs.
	if (setupStatus.data?.needs_setup) {
		return <Navigate to="/setup" replace />;
	}

	// A failed /auth/me is not the same as being logged out.
	//
	// `useMe` turns a 401 into `data === null` — that one really does mean the
	// session is gone, and belongs at the login page. Anything else that
	// throws (the backend restarting, a 502 from nginx, the network dropping)
	// used to land here too and bounce the user to a login form, as though
	// their session had ended. It had not: they would log straight back in the
	// moment the backend answered again, having lost whatever page they were
	// on. Say what actually happened instead, and keep the session.
	if (isError) {
		return <BackendUnreachable error={error} onRetry={() => void refetch()} />;
	}

	// `data === null` means 401 — not logged in
	if (!data || !data.user) {
		return <Navigate to="/login" replace state={{ from: location.pathname }} />;
	}

	if (enforcePasswordSet && data.user.must_change_password && location.pathname !== '/password') {
		return <Navigate to="/password" replace />;
	}

	return <>{children}</>;
}
