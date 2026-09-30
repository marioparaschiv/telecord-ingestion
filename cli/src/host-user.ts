/**
 * The user running the CLI, whom the producers run as so they can read the
 * `config.toml` only its owner may. Undefined on Windows, where Docker
 * Desktop ignores ownership of bind-mounted files.
 *
 * @returns The user and group, which compose reads from `HOST_UID` and `HOST_GID`.
 */
function hostUser(): { uid: number; gid: number } | undefined {
	const uid = process.getuid?.();
	const gid = process.getgid?.();

	return uid === undefined || gid === undefined ? undefined : { uid, gid };
}

export default hostUser;
