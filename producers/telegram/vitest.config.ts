import { defineConfig } from 'vitest/config';

const config = defineConfig({
	resolve: {
		conditions: ['development'],
	},
	test: {
		name: 'telegram',
		include: ['tests/**/*.test.ts'],
	},
});

export default config;
