import { log } from 'evlog';

type TaggedLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

/**
 * Binds a tag to every level of evlog's global `log`, so each line reaches
 * the drains `initLogger` configured.
 *
 * @param tag - The scope shown in brackets, e.g. `'Ingest Connection'`.
 * @returns Leveled log functions bound to that tag.
 */
function createTaggedLogger(tag: string): TaggedLogger {
	return {
		debug: (message) => log.debug(tag, message),
		info: (message) => log.info(tag, message),
		warn: (message) => log.warn(tag, message),
		error: (message) => log.error(tag, message),
	};
}

export type { TaggedLogger };
export default createTaggedLogger;
