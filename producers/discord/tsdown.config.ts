import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['./src/index.ts', './src/config.ts'],
	outDir: './dist',
	format: 'esm',
	target: 'node24',
	platform: 'node',
	clean: true,
	dts: false,
});
