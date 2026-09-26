import { defineConfig } from 'vitest/config';

const config = defineConfig({
	test: {
		projects: ['producers/telegram', 'producers/discord', 'packages/producer-core'],
	},
});

export default config;
