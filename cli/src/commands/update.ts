import { Command } from 'commander';

import { checkForUpdate, downloadAsset, fetchReleases } from '../releases';
import { installedExecutable, replaceExecutable } from '../executable';
import packageJson from '../../package.json' with { type: 'json' };
import { parseChecksums, verifyChecksum } from '../checksums';
import { findTarget } from '../targets';

const update = new Command('update')
	.description('Update telecord-ingestion to the latest release')
	.action(async () => {
		const executable = installedExecutable();

		if (!executable) {
			throw new Error(
				`Failed to update ${process.execPath}: not a telecord-ingestion binary`,
			);
		}

		const target = findTarget(process.platform, process.arch);

		if (!target) {
			throw new Error(`No release is built for ${process.platform}-${process.arch}`);
		}

		const check = checkForUpdate(await fetchReleases(), packageJson.version);

		if (check.status === 'unreleased') {
			throw new Error('Failed to find a stable telecord-ingestion release');
		}

		if (check.status === 'current') {
			console.log(`telecord-ingestion ${packageJson.version} is the latest version.`);

			return;
		}

		const release = check.latest;

		console.log(`Downloading telecord-ingestion ${release.version}...`);

		const [checksums, binary] = await Promise.all([
			downloadAsset(release, 'checksums.txt'),
			downloadAsset(release, target.asset),
		]);

		verifyChecksum(parseChecksums(new TextDecoder().decode(checksums)), target.asset, binary);
		await replaceExecutable(executable, binary);

		console.log(
			`Updated telecord-ingestion from ${packageJson.version} to ${release.version}.`,
		);
	});

export default update;
