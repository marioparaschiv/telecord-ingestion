import { defineConfig } from 'vitest/config';

const config = defineConfig({
	resolve: {
		conditions: ['development'],
	},
	test: {
		name: 'producer-otel',
		include: ['tests/**/*.test.ts'],
	},
});

export default config;
