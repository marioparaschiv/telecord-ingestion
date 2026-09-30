import { asError, createTaggedLogger } from '@telecord/producer-core';

import { setup, shutdown } from './setup';

const logger = createTaggedLogger('Crash');

// A listener replaces Node's own crash, so this one exits with the same code
// once the crash has been exported.
function exitAfterFlush(kind: string) {
	return (error: unknown) => {
		const { message, stack = message } = asError(error);

		logger.error(`${kind}: ${stack}`);

		void shutdown()
			.catch((flushError: unknown) =>
				logger.error(`Failed to flush telemetry: ${asError(flushError).message}`),
			)
			.finally(() => process.exit(1));
	};
}

if (setup()) {
	process.on('uncaughtException', exitAfterFlush('Uncaught exception'));
	process.on('unhandledRejection', exitAfterFlush('Unhandled rejection'));
}
