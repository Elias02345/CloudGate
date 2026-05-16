import { Center, Loader } from '@mantine/core';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMe } from '../api/auth.js';

interface Props {
	children: ReactNode;
	/** When true, redirects to /password if user.must_change_password === true */
	enforcePasswordSet?: boolean;
}

export function ProtectedRoute({ children, enforcePasswordSet = true }: Props) {
	const { data, isLoading, isError } = useMe();
	const location = useLocation();

	if (isLoading) {
		return (
			<Center h="60vh">
				<Loader />
			</Center>
		);
	}

	// `data === null` means 401 — not logged in
	if (isError || !data || !data.user) {
		return <Navigate to="/login" replace state={{ from: location.pathname }} />;
	}

	if (enforcePasswordSet && data.user.must_change_password && location.pathname !== '/password') {
		return <Navigate to="/password" replace />;
	}

	return <>{children}</>;
}
