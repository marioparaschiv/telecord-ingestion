import { defineConfig } from 'vitest/config';

const config = defineConfig({
	resolve: {
		conditions: ['development'],
	},
	test: {
		name: 'discord',
		include: ['tests/**/*.test.ts'],
	},
});

export default config;
