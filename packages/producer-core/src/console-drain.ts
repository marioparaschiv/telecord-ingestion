import type { DrainContext, DrainFn, LogLevel } from 'evlog';

const ansi = {
	reset: '\x1b[0m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	gray: '\x1b[90m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
	error: ansi.red,
	warn: ansi.yellow,
	info: ansi.cyan,
	debug: ansi.gray,
};

function paint(color: string, text: string): string {
	return `${color}${text}${ansi.reset}`;
}

/**
 * Terminal console drain rendering the time, level, service and tag ahead of
 * the message. It replaces evlog's own printer, so pair it with `silent: true`.
 *
 * @returns A drain that writes one styled line per event.
 */
function createConsoleDrain(): DrainFn {
	return ({ event }: DrainContext) => {
		const { timestamp, level, service, tag, message } = event as {
			timestamp?: string;
			level: LogLevel;
			service?: string;
			tag?: string;
			message?: string;
		};

		const color = LEVEL_COLOR[level];
		const time = typeof timestamp === 'string' ? timestamp.slice(11, 23) : '';
		// Display only; the event keeps the full `OTEL_SERVICE_NAME` for export.
		const shortService = (service ?? '').replace(/^telecord-/, '');

		const line = [
			paint(ansi.dim, time),
			paint(color, level.toUpperCase()),
			shortService ? paint(ansi.dim, `(${shortService})`) : '',
			tag ? paint(color, `[${tag.toLowerCase()}]`) : '',
			message ?? '',
		]
			.filter(Boolean)
			.join(' ');

		console[level](line);
	};
}

export default createConsoleDrain;
