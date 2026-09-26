/**
 * A console logger that prefixes every line with its tag.
 *
 * @param tag - The scope shown in brackets, e.g. `'Ingest Connection'`.
 * @returns Leveled log functions bound to that tag.
 */
function createTaggedLogger(tag: string) {
	const prefix = `[${tag}]`;

	return {
		debug: (message: string) => console.debug(prefix, message),
		info: (message: string) => console.info(prefix, message),
		warn: (message: string) => console.warn(prefix, message),
		error: (message: string) => console.error(prefix, message),
	};
}

export default createTaggedLogger;
