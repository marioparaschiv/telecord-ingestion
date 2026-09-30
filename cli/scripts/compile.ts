// Compiles a binary per target into dist/, or only the targets whose assets are named as arguments.
import type { BunPlugin } from 'bun';

import { TARGETS } from '../src/targets';

// Ink imports react-devtools-core only when DEV=true, but the import must still resolve in the
// bundle; marking it external instead crashes the binary at startup.
const stubDevtools: BunPlugin = {
	name: 'stub-react-devtools-core',
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
			path: 'react-devtools-core',
			namespace: 'stub',
		}));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: 'export default {};',
			loader: 'js',
		}));
	},
};

const requested = process.argv.slice(2);
const unknown = requested.filter((asset) => !TARGETS.some((target) => target.asset === asset));

if (unknown.length > 0) {
	throw new Error(`Failed to compile ${unknown.join(', ')}: no such target`);
}

const targets =
	requested.length === 0 ? TARGETS : TARGETS.filter((target) => requested.includes(target.asset));

for (const target of targets) {
	const result = await Bun.build({
		entrypoints: [`${import.meta.dir}/../src/index.ts`],
		compile: {
			target: target.bun,
			outfile: `${import.meta.dir}/../dist/${target.asset}`,
			// The binary runs in users' directories, whose .env and bunfig.toml are not its own.
			autoloadDotenv: false,
			autoloadBunfig: false,
		},
		// Bundles the workspace producers' config schemas from source rather than their build output.
		conditions: ['development'],
		minify: true,
		plugins: [stubDevtools],
	});

	if (!result.success) {
		throw new AggregateError(result.logs, `Failed to compile ${target.asset}`);
	}

	console.log(`Compiled ${target.asset}`);
}
