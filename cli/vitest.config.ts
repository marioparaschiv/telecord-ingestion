import { defineConfig } from 'vitest/config';

const config = defineConfig({
	// Loads `.yml` imports as their text, as bun does for `with { type: 'text' }`.
	plugins: [
		{
			name: 'yml-text',
			transform(code, id) {
				return id.endsWith('.yml') ? `export default ${JSON.stringify(code)};` : undefined;
			},
		},
	],
	test: {
		name: 'cli',
		include: ['tests/**/*.test.{ts,tsx}'],
	},
});

export default config;
