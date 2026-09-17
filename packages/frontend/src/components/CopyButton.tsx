import { useCallback, useEffect, useRef, useState } from 'react';

interface CopyButtonProps {
	value: string;
	timeout?: number;
	children: (payload: { copied: boolean; copy: () => void }) => React.ReactNode;
}

/**
 * Drop-in replacement for Mantine's CopyButton. navigator.clipboard only exists in
 * secure contexts (https / localhost) — CloudGate is typically served over plain
 * http:// on a LAN, where the Mantine version silently does nothing. Falls back to
 * a hidden textarea + document.execCommand('copy'), which works in any context.
 */
export function CopyButton({ value, timeout = 1000, children }: CopyButtonProps) {
	const [copied, setCopied] = useState(false);
	const resetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(resetRef.current), []);

	const copy = useCallback(() => {
		const fallbackCopy = () => {
			const textarea = document.createElement('textarea');
			textarea.value = value;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.focus();
			textarea.select();
			try {
				document.execCommand('copy');
			} catch {
				// nothing more we can do
			}
			document.body.removeChild(textarea);
		};

		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(value).catch(fallbackCopy);
		} else {
			fallbackCopy();
		}

		setCopied(true);
		clearTimeout(resetRef.current);
		resetRef.current = setTimeout(() => setCopied(false), timeout);
	}, [value, timeout]);

	return <>{children({ copied, copy })}</>;
}
