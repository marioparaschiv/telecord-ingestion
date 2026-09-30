import { Command } from 'commander';

import { installDirOption, installedPlatforms, openInstall } from '../install';
import { restartServices } from '../docker';

const restart = new Command('restart')
	.description('Restart the producers, so they read config.toml and compose.yml again')
	.addOption(installDirOption())
	.action(async (options: { dir?: string }) => {
		const install = await openInstall(options.dir);
		const platforms = await installedPlatforms(install);

		if (platforms.length === 0) {
			throw new Error(
				`Failed to restart ${install.dir}: it runs no producer. Run telecord-ingestion setup.`,
			);
		}

		await restartServices(install.dir, platforms);
	});

export default restart;
