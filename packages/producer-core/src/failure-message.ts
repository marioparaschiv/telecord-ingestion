import asError from './as-error';

/** The longest `message` a declined result may carry. */
const FAILURE_MESSAGE_MAX_LENGTH = 512;

/**
 * The `message` of a declined request result, cut to the length the server accepts.
 *
 * @param error - Whatever the failed call threw.
 * @returns The error's message, at most 512 characters long.
 */
function failureMessage(error: unknown): string {
	return asError(error).message.slice(0, FAILURE_MESSAGE_MAX_LENGTH);
}

export default failureMessage;
