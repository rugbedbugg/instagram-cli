/**
 * Loaded by AVA (see `ava.require` in package.json) in every test worker before
 * any test file, so all CLI state lives in a throwaway directory instead of
 * the real `~/.instagram-cli`. The leading underscore keeps AVA from treating
 * this file as a test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {DATA_DIR_ENV_VAR} from '../source/config.js';

const realDataDir = path.join(os.homedir(), '.instagram-cli');
const isolatedDataDir = fs.mkdtempSync(
	path.join(os.tmpdir(), 'instagram-cli-test-'),
);

if (
	isolatedDataDir === realDataDir ||
	isolatedDataDir.startsWith(realDataDir + path.sep)
) {
	throw new Error('Refusing to run tests inside the real CLI data directory');
}

process.env[DATA_DIR_ENV_VAR] = isolatedDataDir;

process.once('exit', () => {
	fs.rmSync(isolatedDataDir, {recursive: true, force: true});
});
