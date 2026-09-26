/**
 * Narrows a caught value to an `Error`, wrapping anything else.
 *
 * @param error - Whatever was thrown.
 * @returns The value itself when it is an `Error`, else an `Error` carrying its string form.
 */
function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export default asError;
