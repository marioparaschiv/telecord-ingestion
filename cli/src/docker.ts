import { spawn } from 'node:child_process';
import { z } from 'zod';

type RunOptions = {
	/** Collect stdout instead of passing it through to the terminal. */
	capture?: boolean;
};

/**
 * Runs the docker CLI, passing stdin and stderr through to the terminal.
 *
 * @param args - Its arguments.
 * @param options - Whether stdout is captured.
 * @returns The captured stdout, or an empty string when it went to the terminal.
 * @throws When docker cannot be started or exits unsuccessfully, naming the command.
 */
export function docker(
	args: readonly string[],
	{ capture = false }: RunOptions = {},
): Promise<string> {
	const command = `docker ${args.join(' ')}`;

	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, {
			stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
		});
		const chunks: Buffer[] = [];

		child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', (error) =>
			reject(new Error(`Failed to run ${command}: ${error.message}`)),
		);
		child.on('close', (code, signal) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks).toString('utf8'));

				return;
			}

			reject(new Error(`Failed to run ${command}: exited with ${signal ?? `code ${code}`}`));
		});
	});
}

/**
 * Runs `docker compose` in an install, which picks up its `.env` and merges
 * its `compose.override.yml` when one exists.
 *
 * @param dir - The install directory.
 * @param args - The compose arguments.
 * @param options - Whether stdout is captured.
 * @returns The captured stdout.
 */
export function compose(
	dir: string,
	args: readonly string[],
	options?: RunOptions,
): Promise<string> {
	return docker(['compose', '--project-directory', dir, ...args], options);
}

/**
 * Recreates services, so they read `config.toml` and `compose.yml` again.
 *
 * @param dir - The install directory.
 * @param services - The services.
 */
export async function restartServices(dir: string, services: readonly string[]): Promise<void> {
	await compose(dir, ['up', '--detach', '--force-recreate', '--no-deps', ...services]);
}

const ComposeModelSchema = z.object({
	name: z.string(),
	services: z.record(
		z.string(),
		z.object({
			image: z.string(),
			environment: z.record(z.string(), z.string().nullable()).optional(),
		}),
	),
	volumes: z.record(z.string(), z.object({ name: z.string() })).optional(),
});

export type ComposeModel = z.output<typeof ComposeModelSchema>;

/**
 * The install's compose model with every profile enabled, overrides merged
 * and variables substituted.
 *
 * @param dir - The install directory.
 * @returns The project name, services and volumes.
 */
export async function composeModel(dir: string): Promise<ComposeModel> {
	const output = await compose(dir, ['--profile', '*', 'config', '--format', 'json'], {
		capture: true,
	});

	return ComposeModelSchema.parse(JSON.parse(output));
}

const ContainerSchema = z.object({
	Service: z.string(),
	State: z.string(),
	Status: z.string(),
});

export type Container = z.output<typeof ContainerSchema>;

/**
 * The install's containers, running or not.
 *
 * @param dir - The install directory.
 * @returns Each container's service, state and status line.
 */
export async function composeContainers(dir: string): Promise<Container[]> {
	const output = await compose(dir, ['--profile', '*', 'ps', '--all', '--format', 'json'], {
		capture: true,
	});

	return output
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => ContainerSchema.parse(JSON.parse(line)));
}
