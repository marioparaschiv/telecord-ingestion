// Imported with `{ type: 'text' }`, which bun and the vitest config load as the file's text.
declare module '*.yml' {
	const text: string;

	export default text;
}
