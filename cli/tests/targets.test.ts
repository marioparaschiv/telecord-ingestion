import { describe, expect, it } from 'vitest';

import { findTarget } from '../src/targets';

describe('findTarget', () => {
	it.each([
		['linux', 'x64', 'telecord-ingestion-linux-x64'],
		['linux', 'arm64', 'telecord-ingestion-linux-arm64'],
		['darwin', 'x64', 'telecord-ingestion-darwin-x64'],
		['darwin', 'arm64', 'telecord-ingestion-darwin-arm64'],
		['win32', 'x64', 'telecord-ingestion-windows-x64.exe'],
	] as const)('picks the %s %s binary', (platform, arch, asset) => {
		expect(findTarget(platform, arch)?.asset).toBe(asset);
	});

	it.each([
		['win32', 'arm64'],
		['linux', 'ia32'],
		['freebsd', 'x64'],
	] as const)('has no binary for %s %s', (platform, arch) => {
		expect(findTarget(platform, arch)).toBeUndefined();
	});
});
