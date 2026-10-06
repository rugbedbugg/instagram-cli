import os from 'node:os';
import path from 'node:path';

/**
 * Expands a path starting with '~' to an absolute path pointing to the user's home directory.
 */
export function expandTilde(filePath: string): string {
	if (filePath === '~') {
		return os.homedir();
	}

	if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
		return path.join(os.homedir(), filePath.slice(2));
	}

	return filePath;
}
