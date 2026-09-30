/** A platform the CLI ships a binary for. */
export type Target = {
	platform: NodeJS.Platform;
	arch: NodeJS.Architecture;
	/** The `bun build --compile --target` it is built with. */
	bun: Bun.Build.CompileTarget;
	/** The release asset holding its binary. */
	asset: string;
};

// The baseline x64 builds skip AVX2, which many virtual machines don't expose.
export const TARGETS: readonly Target[] = [
	{
		platform: 'linux',
		arch: 'x64',
		bun: 'bun-linux-x64-baseline',
		asset: 'telecord-ingestion-linux-x64',
	},
	{
		platform: 'linux',
		arch: 'arm64',
		bun: 'bun-linux-arm64',
		asset: 'telecord-ingestion-linux-arm64',
	},
	{
		platform: 'darwin',
		arch: 'x64',
		bun: 'bun-darwin-x64-baseline',
		asset: 'telecord-ingestion-darwin-x64',
	},
	{
		platform: 'darwin',
		arch: 'arm64',
		bun: 'bun-darwin-arm64',
		asset: 'telecord-ingestion-darwin-arm64',
	},
	{
		platform: 'win32',
		arch: 'x64',
		bun: 'bun-windows-x64-baseline',
		asset: 'telecord-ingestion-windows-x64.exe',
	},
];

/**
 * Finds the release binary for a platform and architecture.
 *
 * @param platform - The operating system, as `process.platform` names it.
 * @param arch - The CPU architecture, as `process.arch` names it.
 * @returns The target, or undefined when no binary is built for it.
 */
export function findTarget(
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
): Target | undefined {
	return TARGETS.find((target) => target.platform === platform && target.arch === arch);
}
