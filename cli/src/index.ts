import { Command } from 'commander';

import { installedExecutable, removeReplacedExecutable } from './executable';
import packageJson from '../package.json' with { type: 'json' };
import uninstall from './commands/uninstall';
import errorMessage from './error-message';
import filters from './commands/filters';
import restart from './commands/restart';
import config from './commands/config';
import status from './commands/status';
import update from './commands/update';
import login from './commands/login';
import setup from './commands/setup';
import logs from './commands/logs';

const program = new Command('telecord-ingestion')
	.description('Set up and manage the Telecord ingestion producers')
	.version(packageJson.version)
	.addCommand(setup)
	.addCommand(login)
	.addCommand(config)
	.addCommand(filters)
	.addCommand(status)
	.addCommand(logs)
	.addCommand(restart)
	.addCommand(uninstall)
	.addCommand(update);

const executable = installedExecutable();

try {
	if (executable && process.platform === 'win32') {
		await removeReplacedExecutable(executable);
	}

	await program.parseAsync();
} catch (error) {
	console.error(`Error: ${errorMessage(error)}`);
	process.exitCode = 1;
}
