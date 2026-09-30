import { initLogger as initEvlog, type DrainFn, type LoggerConfig } from 'evlog';

type LoggerOptions = {
	service?: string;
	silent?: boolean;
	drain?: DrainFn;
};

/**
 * Configures evlog's global logger for a producer.
 *
 * @param options - Service identity, whether evlog's own printer is silenced, and the drain.
 */
function initLogger({ service, silent, drain }: LoggerOptions = {}): void {
	const config: LoggerConfig = { silent, drain };

	if (service) {
		config.env = { service };
	}

	initEvlog(config);
}

export type { LoggerOptions };
export default initLogger;
