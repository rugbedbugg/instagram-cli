import {Buffer} from 'node:buffer';
import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileTypeFromBuffer} from 'file-type';
import {resolveDataDir} from '../config.js';
import {createContextualLogger} from './logger.js';

/**
 * The single boundary for reading local files that may be sent to Instagram.
 *
 * Flow: requested path → resolve (~, relative, ..) → classify spelling →
 * realpath → classify canonical target → stat/open (regular file, size) →
 * ApprovedLocalFile. Content is only read later, from a handle whose identity
 * must still match the approved file, via readTextForEmbedding,
 * readMediaForUpload or readAttachment.
 *
 * See docs/local-file-safety.md for the threat model and its limits.
 */

const logger = createContextualLogger('LocalFilePolicy');

export type FileAccessRoots = {
	readonly homeDir: string;
	readonly dataDir: string;
	readonly cwd: string;
};

export function getDefaultFileAccessRoots(): FileAccessRoots {
	return {homeDir: os.homedir(), dataDir: resolveDataDir(), cwd: process.cwd()};
}

export type FileSizeLimits = {
	readonly textEmbedBytes: number;
	readonly photoUploadBytes: number;
	readonly videoUploadBytes: number;
};

/**
 * Text embeds are appended inline to a single DM, so they are kept to a short
 * snippet. Media is buffered fully in memory and sent in one non-segmented
 * request by instagram-private-api, so uploads are capped to bound memory use.
 * Instagram's own server-side limits are not verified here.
 */
export const defaultFileSizeLimits: FileSizeLimits = {
	textEmbedBytes: 16 * 1024,
	photoUploadBytes: 25 * 1024 * 1024,
	videoUploadBytes: 100 * 1024 * 1024,
};

export type FileAccessOptions = {
	readonly roots?: FileAccessRoots;
	readonly limits?: FileSizeLimits;
};

/** What the caller intends to do with the file; sets the size ceiling at approval. */
export type LocalFilePurpose = 'text-embed' | 'media-upload' | 'attachment';

export type LocalFileRejection =
	| 'empty-path'
	| 'not-found'
	| 'not-a-file'
	| 'sensitive'
	| 'too-large'
	| 'unsupported-type'
	| 'changed'
	| 'unreadable'
	| 'secret-content';

export type SensitiveCategory =
	| 'ssh'
	| 'gpg'
	| 'cloud-credentials'
	| 'git-credentials'
	| 'package-credentials'
	| 'netrc'
	| 'environment-file'
	| 'instagram-cli-data'
	| 'browser-profile'
	| 'password-store'
	| 'private-key'
	| 'token-file'
	| 'shell-history'
	| 'system';

const categoryLabels: Record<SensitiveCategory, string> = {
	ssh: 'SSH keys and config',
	gpg: 'GnuPG keyring',
	'cloud-credentials': 'cloud or cluster credentials',
	'git-credentials': 'Git credentials or repository internals',
	'package-credentials': 'package registry credentials',
	netrc: 'netrc credentials',
	'environment-file': 'environment file',
	'instagram-cli-data': 'Instagram CLI sessions, config or logs',
	'browser-profile': 'browser profile or saved logins',
	'password-store': 'password store or keyring',
	'private-key': 'private key or certificate',
	'token-file': 'token or secrets file',
	'shell-history': 'shell history',
	system: 'system file',
};

/**
 * Error shown to the local user. Messages carry only the file's base name,
 * never the absolute path, so they are safe to display and log.
 */
export class LocalFileError extends Error {
	readonly code: LocalFileRejection;
	readonly displayName: string;
	readonly category: SensitiveCategory | undefined;

	constructor(
		code: LocalFileRejection,
		displayName: string,
		category?: SensitiveCategory,
		detail?: string,
	) {
		super(describeRejection(code, displayName, category, detail));
		this.name = 'LocalFileError';
		this.code = code;
		this.displayName = displayName;
		this.category = category;
	}
}

function describeRejection(
	code: LocalFileRejection,
	name: string,
	category?: SensitiveCategory,
	detail?: string,
): string {
	const quoted = `"${name}"`;
	switch (code) {
		case 'empty-path': {
			return 'No file path was given.';
		}

		case 'not-found': {
			return `${quoted} was not found.`;
		}

		case 'not-a-file': {
			return `${quoted} is not a regular file.`;
		}

		case 'sensitive': {
			return `${quoted} is in a protected location (${
				category ? categoryLabels[category] : 'sensitive file'
			}) and cannot be sent.`;
		}

		case 'too-large': {
			return `${quoted} is too large to send${detail ? ` (${detail})` : ''}.`;
		}

		case 'unsupported-type': {
			return `${quoted} is not a supported file type${
				detail ? ` (${detail})` : ''
			}.`;
		}

		case 'changed': {
			return `${quoted} changed after it was approved.`;
		}

		case 'unreadable': {
			return `${quoted} could not be read.`;
		}

		case 'secret-content': {
			return `${quoted} appears to contain a private key or access token and cannot be sent.`;
		}
	}
}

function reject(
	code: LocalFileRejection,
	displayName: string,
	category?: SensitiveCategory,
	detail?: string,
): never {
	// Never log the path or file name: blocked files are often sensitive.
	logger.warn(
		`Local file rejected: ${code}${category ? ` (${category})` : ''}`,
	);
	throw new LocalFileError(code, displayName, category, detail);
}

// ── Sensitive path classification ────────────────────────────────────────────

type DirectoryRule = {
	readonly segments: readonly string[];
	readonly category: SensitiveCategory;
};

/** Directory sequences that are protected wherever they appear in a path. */
const sensitiveDirectories: readonly DirectoryRule[] = [
	{segments: ['.ssh'], category: 'ssh'},
	{segments: ['.gnupg'], category: 'gpg'},
	{segments: ['.aws'], category: 'cloud-credentials'},
	{segments: ['.azure'], category: 'cloud-credentials'},
	{segments: ['.kube'], category: 'cloud-credentials'},
	{segments: ['.docker'], category: 'cloud-credentials'},
	{segments: ['.config', 'gcloud'], category: 'cloud-credentials'},
	{segments: ['.git'], category: 'git-credentials'},
	{segments: ['.config', 'gh'], category: 'git-credentials'},
	{segments: ['.config', 'hub'], category: 'git-credentials'},
	{segments: ['.cargo', 'credentials'], category: 'package-credentials'},
	{segments: ['.cargo', 'credentials.toml'], category: 'package-credentials'},
	{segments: ['.gem', 'credentials'], category: 'package-credentials'},
	{segments: ['.instagram-cli'], category: 'instagram-cli-data'},
	{segments: ['.password-store'], category: 'password-store'},
	{segments: ['keyrings'], category: 'password-store'},
	{segments: ['library', 'keychains'], category: 'password-store'},
	{segments: ['.mozilla'], category: 'browser-profile'},
	{segments: ['.thunderbird'], category: 'browser-profile'},
	{segments: ['.config', 'google-chrome'], category: 'browser-profile'},
	{segments: ['.config', 'chromium'], category: 'browser-profile'},
	{segments: ['.config', 'bravesoftware'], category: 'browser-profile'},
	{segments: ['.config', 'microsoft-edge'], category: 'browser-profile'},
	{segments: ['.config', 'vivaldi'], category: 'browser-profile'},
	{segments: ['library', 'cookies'], category: 'browser-profile'},
	{
		segments: ['library', 'application support', 'google', 'chrome'],
		category: 'browser-profile',
	},
	{
		segments: ['library', 'application support', 'firefox'],
		category: 'browser-profile',
	},
	{
		segments: ['library', 'application support', 'bravesoftware'],
		category: 'browser-profile',
	},
	{segments: ['appdata', 'roaming', 'mozilla'], category: 'browser-profile'},
	{
		segments: ['appdata', 'local', 'google', 'chrome', 'user data'],
		category: 'browser-profile',
	},
	{
		segments: ['appdata', 'local', 'microsoft', 'edge', 'user data'],
		category: 'browser-profile',
	},
	{segments: ['windows', 'system32', 'config'], category: 'system'},
];

/** Directory sequences protected only at the filesystem root (POSIX). */
const sensitiveRootDirectories: readonly DirectoryRule[] = [
	{segments: ['proc'], category: 'system'},
	{segments: ['sys'], category: 'system'},
	{segments: ['dev'], category: 'system'},
	{segments: ['etc', 'shadow'], category: 'system'},
	{segments: ['etc', 'gshadow'], category: 'system'},
	{segments: ['etc', 'sudoers'], category: 'system'},
	{segments: ['etc', 'sudoers.d'], category: 'system'},
	{segments: ['etc', 'ssh'], category: 'ssh'},
];

const sensitiveFileNames: ReadonlyMap<string, SensitiveCategory> = new Map([
	['known_hosts', 'ssh'],
	['authorized_keys', 'ssh'],
	['.netrc', 'netrc'],
	['_netrc', 'netrc'],
	['.git-credentials', 'git-credentials'],
	['.gitconfig', 'git-credentials'],
	['.npmrc', 'package-credentials'],
	['.yarnrc', 'package-credentials'],
	['.yarnrc.yml', 'package-credentials'],
	['.pypirc', 'package-credentials'],
	['.pgpass', 'token-file'],
	['.my.cnf', 'token-file'],
	['.htpasswd', 'token-file'],
	['.boto', 'cloud-credentials'],
	['.s3cfg', 'cloud-credentials'],
	['kubeconfig', 'cloud-credentials'],
	['.vault-token', 'token-file'],
	['.terraformrc', 'token-file'],
	['credentials', 'token-file'],
	['credentials.json', 'token-file'],
	['credentials.toml', 'token-file'],
	['token', 'token-file'],
	['token.json', 'token-file'],
	['tokens.json', 'token-file'],
	['.token', 'token-file'],
	['wallet.dat', 'private-key'],
	['login data', 'browser-profile'],
	['logins.json', 'browser-profile'],
	['key3.db', 'browser-profile'],
	['key4.db', 'browser-profile'],
	['cookies', 'browser-profile'],
	['cookies.sqlite', 'browser-profile'],
	['session.ts.json', 'instagram-cli-data'],
	['config.ts.yaml', 'instagram-cli-data'],
]);

const sensitiveFilePatterns: ReadonlyArray<{
	readonly pattern: RegExp;
	readonly category: SensitiveCategory;
}> = [
	{
		pattern: /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[-_]sk)?(?:\.pub)?$/,
		category: 'ssh',
	},
	{pattern: /^\.env(?:\..+)?$/, category: 'environment-file'},
	{
		pattern: /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|ovpn|gpg)$/,
		category: 'private-key',
	},
	{pattern: /^client_secret.*\.json$/, category: 'token-file'},
	{
		pattern: /^\.?secrets?\.(?:json|ya?ml|toml|env|txt)$/,
		category: 'token-file',
	},
	{pattern: /\.token$/, category: 'token-file'},
	{pattern: /_history$/, category: 'shell-history'},
];

/** Lower-cased path segments, splitting on both separators for portability. */
function toSegments(filePath: string): string[] {
	return filePath
		.toLowerCase()
		.split(/[\\/]+/)
		.filter(segment => segment.length > 0);
}

function containsSequence(
	haystack: readonly string[],
	needle: readonly string[],
): boolean {
	for (let start = 0; start + needle.length <= haystack.length; start++) {
		if (
			needle.every((segment, offset) => haystack[start + offset] === segment)
		) {
			return true;
		}
	}

	return false;
}

function startsWithSequence(
	haystack: readonly string[],
	needle: readonly string[],
): boolean {
	return (
		needle.length > 0 &&
		needle.length <= haystack.length &&
		needle.every((segment, index) => haystack[index] === segment)
	);
}

/**
 * Classifies an absolute path as sensitive, or returns undefined.
 *
 * Matching is case-insensitive on every platform and accepts both `/` and `\`
 * separators. This over-blocks slightly on case-sensitive filesystems, which is
 * the intended fail-closed direction.
 *
 * @param filePath - Absolute path to classify (spelling or canonical target).
 * @param protectedDirs - Extra directories to protect entirely (e.g. the CLI data dir).
 */
export function classifySensitivePath(
	filePath: string,
	protectedDirs: readonly string[] = [],
): SensitiveCategory | undefined {
	const segments = toSegments(filePath);

	for (const directory of protectedDirs) {
		if (startsWithSequence(segments, toSegments(directory))) {
			return 'instagram-cli-data';
		}
	}

	if (filePath.startsWith('/')) {
		for (const rule of sensitiveRootDirectories) {
			if (startsWithSequence(segments, rule.segments)) {
				return rule.category;
			}
		}
	}

	for (const rule of sensitiveDirectories) {
		if (containsSequence(segments, rule.segments)) {
			return rule.category;
		}
	}

	const fileName = segments.at(-1) ?? '';
	const byName = sensitiveFileNames.get(fileName);
	if (byName) {
		return byName;
	}

	for (const {pattern, category} of sensitiveFilePatterns) {
		if (pattern.test(fileName)) {
			return category;
		}
	}

	return undefined;
}

/** Content patterns that indicate credentials regardless of file name. */
const secretContentPatterns: readonly RegExp[] = [
	/-----BEGIN [A-Z\d ]*PRIVATE KEY(?: BLOCK)?-----/,
	/\b(?:AKIA|ASIA)[A-Z\d]{16}\b/,
	/\bgh[pousr]_[A-Za-z\d]{36,}\b/,
	/\bgithub_pat_\w{20,}\b/,
	/\bglpat-[\w-]{20,}\b/,
	/\bxox[abprs]-[A-Za-z\d-]{10,}\b/,
	/\bnpm_[A-Za-z\d]{36}\b/,
	/\bsk-[\w-]{20,}\b/,
	/\bAIza[\w-]{35}\b/,
];

export function containsSecretContent(text: string): boolean {
	return secretContentPatterns.some(pattern => pattern.test(text));
}

// ── Approval ─────────────────────────────────────────────────────────────────

type FileIdentity = {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
};

type ApprovalInternals = {
	readonly canonicalPath: string;
	readonly identity: FileIdentity;
	readonly limits: FileSizeLimits;
};

/**
 * A local file that passed path policy checks. It can only be created by
 * approveLocalFile; look-alike objects are rejected when read.
 */
export type ApprovedLocalFile = {
	readonly displayName: string;
	readonly size: number;
	readonly purpose: LocalFilePurpose;
};

const approvedFiles = new WeakMap<ApprovedLocalFile, ApprovalInternals>();

// O_NOFOLLOW guards the final component; O_NONBLOCK keeps FIFOs from hanging.
// Both are undefined on Windows.
const openFlags =
	fsConstants.O_RDONLY |
	(fsConstants.O_NOFOLLOW ?? 0) |
	(fsConstants.O_NONBLOCK ?? 0);

function resolveRequestedPath(
	requested: string,
	roots: FileAccessRoots,
): string {
	let expanded = requested;
	if (expanded === '~') {
		expanded = roots.homeDir;
	} else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
		expanded = path.join(roots.homeDir, expanded.slice(2));
	}

	return path.resolve(roots.cwd, expanded);
}

async function realpathOrResolved(directory: string): Promise<string> {
	try {
		return await fs.realpath(directory);
	} catch {
		return path.resolve(directory);
	}
}

function maxBytesFor(
	purpose: LocalFilePurpose,
	limits: FileSizeLimits,
): number {
	const media = Math.max(limits.photoUploadBytes, limits.videoUploadBytes);
	switch (purpose) {
		case 'text-embed': {
			return limits.textEmbedBytes;
		}

		case 'media-upload': {
			return media;
		}

		case 'attachment': {
			return Math.max(limits.textEmbedBytes, limits.photoUploadBytes);
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isNotFoundError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

function sameIdentity(
	stat: {dev: number; ino: number; size: number; mtimeMs: number},
	identity: FileIdentity,
): boolean {
	return (
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.size === identity.size &&
		stat.mtimeMs === identity.mtimeMs
	);
}

/**
 * Resolves and validates a user-requested local file without reading its
 * content. Throws LocalFileError when the file must not be used.
 *
 * @param requestedPath - Path as the user wrote it (`~`, relative and `..` allowed).
 * @param purpose - Intended use; sets the size ceiling checked here.
 */
export async function approveLocalFile(
	requestedPath: string,
	purpose: LocalFilePurpose,
	options: FileAccessOptions = {},
): Promise<ApprovedLocalFile> {
	const roots = options.roots ?? getDefaultFileAccessRoots();
	const limits = options.limits ?? defaultFileSizeLimits;
	const requested = requestedPath.trim();
	// Base name only, for either separator style; never the full path.
	const displayName = path.posix.basename(requested.replaceAll('\\', '/'));

	if (requested.length === 0) {
		reject('empty-path', '');
	}

	const protectedDirs = [
		path.resolve(roots.dataDir),
		await realpathOrResolved(roots.dataDir),
	];

	// Check the spelling first so a sensitive location is never even resolved.
	const absolute = resolveRequestedPath(requested, roots);
	const spellingCategory = classifySensitivePath(absolute, protectedDirs);
	if (spellingCategory) {
		reject('sensitive', displayName, spellingCategory);
	}

	let canonicalPath: string;
	try {
		canonicalPath = await fs.realpath(absolute);
	} catch (error) {
		reject(isNotFoundError(error) ? 'not-found' : 'unreadable', displayName);
	}

	const canonicalCategory = classifySensitivePath(canonicalPath, protectedDirs);
	if (canonicalCategory) {
		reject('sensitive', displayName, canonicalCategory);
	}

	let stat;
	try {
		stat = await fs.stat(canonicalPath);
	} catch (error) {
		reject(isNotFoundError(error) ? 'not-found' : 'unreadable', displayName);
	}

	// Reject directories, FIFOs, sockets and devices before opening anything.
	if (!stat.isFile()) {
		reject('not-a-file', displayName);
	}

	const maxBytes = maxBytesFor(purpose, limits);
	if (stat.size > maxBytes) {
		reject(
			'too-large',
			displayName,
			undefined,
			`limit ${formatBytes(maxBytes)}`,
		);
	}

	// Pin the identity of what we approved via an opened handle.
	let identity: FileIdentity;
	try {
		const handle = await fs.open(canonicalPath, openFlags);
		try {
			const handleStat = await handle.stat();
			if (
				!handleStat.isFile() ||
				handleStat.dev !== stat.dev ||
				handleStat.ino !== stat.ino
			) {
				reject('changed', displayName);
			}

			identity = {
				dev: handleStat.dev,
				ino: handleStat.ino,
				size: handleStat.size,
				mtimeMs: handleStat.mtimeMs,
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof LocalFileError) {
			throw error;
		}

		reject(isNotFoundError(error) ? 'changed' : 'unreadable', displayName);
	}

	const approved: ApprovedLocalFile = Object.freeze({
		displayName,
		size: identity.size,
		purpose,
	});
	approvedFiles.set(approved, {canonicalPath, identity, limits});
	logger.debug(`Local file approved for ${purpose} (${identity.size} bytes)`);
	return approved;
}

function getInternals(file: ApprovedLocalFile): ApprovalInternals {
	const internals = approvedFiles.get(file);
	if (!internals) {
		throw new TypeError('File was not approved by approveLocalFile()');
	}

	return internals;
}

/**
 * Reads at most `maxBytes` from the approved file, failing if the file on disk
 * is no longer the one that was approved.
 */
async function readVerifiedBytes(
	file: ApprovedLocalFile,
	maxBytes: number,
): Promise<Uint8Array> {
	const {canonicalPath, identity} = getInternals(file);

	let handle;
	try {
		handle = await fs.open(canonicalPath, openFlags);
	} catch (error) {
		reject(isNotFoundError(error) ? 'changed' : 'unreadable', file.displayName);
	}

	try {
		const stat = await handle.stat();
		if (!stat.isFile() || !sameIdentity(stat, identity)) {
			reject('changed', file.displayName);
		}

		if (stat.size > maxBytes) {
			reject(
				'too-large',
				file.displayName,
				undefined,
				`limit ${formatBytes(maxBytes)}`,
			);
		}

		// Read one byte past the expected size to detect growth after stat.
		const buffer = Buffer.alloc(stat.size + 1);
		let total = 0;
		while (total < buffer.length) {
			// eslint-disable-next-line no-await-in-loop
			const {bytesRead} = await handle.read(
				buffer,
				total,
				buffer.length - total,
				total,
			);
			if (bytesRead === 0) break;
			total += bytesRead;
		}

		if (total !== stat.size) {
			reject('changed', file.displayName);
		}

		return buffer.subarray(0, total);
	} finally {
		await handle.close();
	}
}

// ── Content readers ──────────────────────────────────────────────────────────

const photoMimeTypes = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/heic',
	'image/heif',
]);

const videoMimeTypes = new Set([
	'video/mp4',
	'video/quicktime',
	'video/webm',
	'video/x-matroska',
	'video/vnd.avi',
	'video/x-msvideo',
]);

export type MediaKind = 'photo' | 'video';

/**
 * Media bytes that passed the local file policy. Only this module can create
 * them, and InstagramClient upload methods accept nothing else.
 */
export type PreparedMedia = {
	readonly kind: MediaKind;
	readonly mime: string;
	readonly bytes: Uint8Array;
	readonly displayName: string;
};

const preparedMedia = new WeakSet<PreparedMedia>();

export function isPreparedMedia(value: unknown): value is PreparedMedia {
	return (
		typeof value === 'object' &&
		value !== null &&
		preparedMedia.has(value as PreparedMedia)
	);
}

function prepareMedia(
	file: ApprovedLocalFile,
	bytes: Uint8Array,
	kind: MediaKind,
	mime: string,
): PreparedMedia {
	const media: PreparedMedia = Object.freeze({
		kind,
		mime,
		bytes,
		displayName: file.displayName,
	});
	preparedMedia.add(media);
	return media;
}

function mediaKindForMime(mime: string | undefined): MediaKind | undefined {
	if (mime && photoMimeTypes.has(mime)) return 'photo';
	if (mime && videoMimeTypes.has(mime)) return 'video';
	return undefined;
}

/**
 * Reads an approved file for upload as a photo or video. The type is taken from
 * the file's content, not its name; `requestedKind` must agree with it.
 */
export async function readMediaForUpload(
	file: ApprovedLocalFile,
	requestedKind: MediaKind | 'auto' = 'auto',
): Promise<PreparedMedia> {
	const {limits} = getInternals(file);
	const bytes = await readVerifiedBytes(
		file,
		Math.max(limits.photoUploadBytes, limits.videoUploadBytes),
	);
	const detected = await fileTypeFromBuffer(bytes);
	const kind = mediaKindForMime(detected?.mime);

	if (!kind || !detected) {
		reject(
			'unsupported-type',
			file.displayName,
			undefined,
			'expected an image or video',
		);
	}

	if (requestedKind !== 'auto' && requestedKind !== kind) {
		reject(
			'unsupported-type',
			file.displayName,
			undefined,
			`content is not a ${requestedKind}`,
		);
	}

	const limit =
		kind === 'photo' ? limits.photoUploadBytes : limits.videoUploadBytes;
	if (bytes.length > limit) {
		reject(
			'too-large',
			file.displayName,
			undefined,
			`limit ${formatBytes(limit)}`,
		);
	}

	return prepareMedia(file, bytes, kind, detected.mime);
}

function decodeEmbeddableText(
	file: ApprovedLocalFile,
	bytes: Uint8Array,
): string {
	if (bytes.includes(0)) {
		reject('unsupported-type', file.displayName, undefined, 'binary file');
	}

	let text: string;
	try {
		text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
	} catch {
		reject('unsupported-type', file.displayName, undefined, 'not UTF-8 text');
	}

	if (containsSecretContent(text)) {
		reject('secret-content', file.displayName);
	}

	return text;
}

/** Reads an approved file as UTF-8 text to embed in a message. */
export async function readTextForEmbedding(
	file: ApprovedLocalFile,
): Promise<string> {
	const {limits} = getInternals(file);
	const bytes = await readVerifiedBytes(file, limits.textEmbedBytes);
	const detected = await fileTypeFromBuffer(bytes);
	if (detected && !detected.mime.startsWith('text/')) {
		reject('unsupported-type', file.displayName, undefined, detected.mime);
	}

	return decodeEmbeddableText(file, bytes);
}

export type PreparedAttachment =
	| {readonly type: 'photo'; readonly media: PreparedMedia}
	| {
			readonly type: 'text';
			readonly displayName: string;
			readonly text: string;
	  };

/**
 * Reads an approved `#path` attachment: images become photo uploads, anything
 * else must be embeddable UTF-8 text. Videos must be sent with `:upload`.
 */
export async function readAttachment(
	file: ApprovedLocalFile,
): Promise<PreparedAttachment> {
	const {limits} = getInternals(file);
	const bytes = await readVerifiedBytes(
		file,
		Math.max(limits.textEmbedBytes, limits.photoUploadBytes),
	);
	const detected = await fileTypeFromBuffer(bytes);
	const kind = mediaKindForMime(detected?.mime);

	if (kind === 'photo' && detected) {
		return {
			type: 'photo',
			media: prepareMedia(file, bytes, 'photo', detected.mime),
		};
	}

	if (kind === 'video') {
		reject(
			'unsupported-type',
			file.displayName,
			undefined,
			'send videos with :upload',
		);
	}

	if (detected && !detected.mime.startsWith('text/')) {
		reject('unsupported-type', file.displayName, undefined, detected.mime);
	}

	if (bytes.length > limits.textEmbedBytes) {
		reject(
			'too-large',
			file.displayName,
			undefined,
			`text limit ${formatBytes(limits.textEmbedBytes)}`,
		);
	}

	return {
		type: 'text',
		displayName: file.displayName,
		text: decodeEmbeddableText(file, bytes),
	};
}
