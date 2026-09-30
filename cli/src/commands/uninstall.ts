import { input } from '@inquirer/prompts';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { Command } from 'commander';

import { installDirOption, openInstall } from '../install';
import { canPrompt, readStdin } from '../prompt';
import { compose } from '../docker';

const uninstall = new Command('uninstall')
	.description('Remove the containers, keeping config.toml and the account data')
	.option(
		'--purge',
		'Also delete the account data volumes and the install directory, once you type its name',
	)
	.addOption(installDirOption())
	.action(async (options: { dir?: string; purge?: boolean }) => {
		const install = await openInstall(options.dir);

		if (!options.purge) {
			await compose(install.dir, ['--profile', '*', 'down', '--remove-orphans']);
			console.log(`Removed the containers. ${install.config} is kept.`);

			return;
		}

		const name = basename(install.dir);
		const message = `This deletes ${install.dir} and the account data, including the Telegram session. Type ${name} to confirm`;
		let typed: string;

		if (canPrompt()) {
			typed = await input({ message });
		} else {
			console.log(`${message}:`);
			typed = await readStdin();
		}

		if (typed.trim() !== name) {
			throw new Error(`Failed to purge ${install.dir}: the name typed was not ${name}`);
		}

		await compose(install.dir, ['--profile', '*', 'down', '--remove-orphans', '--volumes']);
		await rm(install.dir, { recursive: true, force: true });
		console.log(`Removed the containers, the data volumes and ${install.dir}.`);
	});

export default uninstall;
