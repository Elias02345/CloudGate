import type { KeyboardEvent } from 'react';

/**
 * Makes a row or card that selects something on click usable from a keyboard.
 *
 * A `<tr>` or a Paper with an onClick looks like a button and is not one:
 * it is outside the Tab order and ignores Enter, so picking an account —
 * which is how you get to its zones — needed a mouse. This adds exactly what
 * a native button would have: a Tab stop and Enter/Space activation.
 *
 * Semantics stay with the caller, because they differ: a table row keeps its
 * row role and says `aria-selected`; a card has none, so it takes
 * `role="button"` and `aria-pressed`.
 */
export function selectableProps(selected: boolean, onSelect: () => void) {
	return {
		tabIndex: 0,
		'data-selected': selected || undefined,
		onClick: onSelect,
		onKeyDown: (e: KeyboardEvent) => {
			// Only the element itself: a key pressed on a button inside the row
			// (delete, copy) belongs to that button.
			if (e.target !== e.currentTarget) return;
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault(); // Space would otherwise scroll the page
				onSelect();
			}
		},
	};
}
