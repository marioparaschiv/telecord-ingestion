import { render } from 'ink';

import type { PickerState } from './model';

import Picker, { type PickerProps } from './picker';

/**
 * Shows the picker full-screen until the selection is saved or cancelled.
 * Ctrl+C cancels through the picker rather than killing the process.
 *
 * @param props - The account's chats, the current selection and the `filter` table.
 * @returns The selection to save, or undefined when cancelled.
 */
async function runPicker<Entry extends object>(
	props: Omit<PickerProps<Entry>, 'onDone'>,
): Promise<PickerState<Entry> | undefined> {
	let result: PickerState<Entry> | undefined;
	const instance = render(
		<Picker
			{...props}
			onDone={(state) => {
				result = state;
			}}
		/>,
		{
			exitOnCtrlC: false,
			// On Windows, bun fails to set raw mode again once the alternate screen is left, which
			// breaks the prompts that follow the picker.
			alternateScreen: process.platform !== 'win32',
		},
	);

	await instance.waitUntilExit();

	return result;
}

export default runPicker;
