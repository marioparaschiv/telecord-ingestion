/**
 * The message of a caught value.
 *
 * @param error - Whatever was thrown.
 * @returns Its message when it is an `Error`, else its string form.
 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default errorMessage;
