import { LogManager } from '@mtcute/node/utils.js';
import { format } from 'node:util';

import { createTaggedLogger, type TaggedLogger } from '@telecord/producer-core';

function levelOf(level: number): keyof TaggedLogger {
	switch (level) {
		case LogManager.ERROR:
			return 'error';

		case LogManager.WARN:
			return 'warn';

		case LogManager.INFO:
			return 'info';

		default:
			return 'debug';
	}
}

/**
 * Routes a log manager's lines through the producer's logger in place of
 * mtcute's own console printer, under the tag `mtcute <tag>`. The manager's
 * level is left as it is.
 *
 * @param manager - The client's log manager, `client.log.mgr`.
 */
function bridgeMtcuteLogs(manager: LogManager): void {
	// mtcute has already expanded its own specifiers (%h, %j, %e, ...) by now;
	// what is left in `fmt` is util.format's.
	manager.handler = (_color, level, tag, fmt, args) => {
		createTaggedLogger(`mtcute ${tag}`)[levelOf(level)](format(fmt, ...args));
	};
}

export default bridgeMtcuteLogs;
