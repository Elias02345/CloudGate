import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { type ReactNode, createContext, useCallback, useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Replaces the browser's `confirm()`.
 *
 * Every destructive action in CloudGate used to go through the native dialog.
 * It cannot be styled, so it arrives as a grey system box in the middle of an
 * otherwise designed application; it cannot be translated, so it says "OK" and
 * "Cancel" whatever language the user picked; and it blocks the whole renderer
 * while it is open. Some browsers also suppress it outright after repeated use
 * on one page, which silently turns "are you sure?" into "yes".
 *
 * This keeps the same shape at the call site — `if (!(await confirm(…)))
 * return;` — so the guard reads the way it did, and adds no dependency:
 * Mantine's Modal was already here.
 */

export interface ConfirmOptions {
	title: string;
	/** Body text. Accepts a node so a caller can bold the thing being deleted. */
	message: ReactNode;
	/** Defaults to the shared "confirm" label. */
	confirmLabel?: string;
	/** Red confirm button for anything that destroys or disconnects. */
	danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
	const { t } = useTranslation();
	const [options, setOptions] = useState<ConfirmOptions | null>(null);
	// Held across renders so the modal's buttons settle the promise the caller
	// is awaiting, rather than a stale one from a previous prompt.
	const resolveRef = useRef<((value: boolean) => void) | null>(null);

	const confirm = useCallback<ConfirmFn>((opts) => {
		// A second prompt before the first is answered — a double-click on a
		// delete button fires two handlers before React has even mounted the
		// modal. Overwriting the resolver would strand the first caller's
		// promise forever: whoever awaited it would sit there, and the guard
		// it belongs to (`if (!(await confirm(…))) return;`) would never run or
		// return. Settle the superseded one as "no" first — the user has not
		// answered it, and declining is the only safe reading of that.
		resolveRef.current?.(false);
		setOptions(opts);
		return new Promise<boolean>((resolve) => {
			resolveRef.current = resolve;
		});
	}, []);

	const settle = (answer: boolean) => {
		resolveRef.current?.(answer);
		resolveRef.current = null;
		setOptions(null);
	};

	return (
		<ConfirmContext.Provider value={confirm}>
			{children}
			<Modal
				opened={options !== null}
				// Escape and the backdrop mean "no" — the same as dismissing the
				// native dialog, and never an accidental yes.
				onClose={() => settle(false)}
				title={options?.title}
				centered
				size="md"
			>
				<Stack gap="md">
					{typeof options?.message === 'string' ? <Text size="sm">{options.message}</Text> : options?.message}
					<Group justify="flex-end" gap="sm">
						<Button variant="default" onClick={() => settle(false)}>
							{t('common.cancel')}
						</Button>
						<Button color={options?.danger ? 'red' : undefined} onClick={() => settle(true)} data-autofocus>
							{options?.confirmLabel ?? t('common.confirm')}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</ConfirmContext.Provider>
	);
}

/**
 * `const confirm = useConfirm();` then `if (!(await confirm({…}))) return;`
 */
export function useConfirm(): ConfirmFn {
	const ctx = useContext(ConfirmContext);
	if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
	return ctx;
}
