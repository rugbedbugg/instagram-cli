/* eslint-disable @typescript-eslint/no-unsafe-call */

import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	chatCommands,
	type ChatCommandContext,
} from '../source/utils/chat-commands.js';
import type {InstagramClient} from '../source/client.js';
import type {PreparedMedia} from '../source/utils/local-file-policy.js';
import type {ChatState, Message} from '../source/types/instagram.js';

// ── Fixtures (temporary directory only) ──────────────────────────────────────

const pngBytes = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);
const mp4Bytes = Buffer.concat([
	Buffer.from([0, 0, 0, 0x18]),
	Buffer.from('ftypmp42'),
	Buffer.from([0, 0, 0, 0]),
	Buffer.from('mp42isom'),
]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-cli-upload-'));
const fixture = (...parts: string[]) => path.join(root, ...parts);

test.before(() => {
	fs.mkdirSync(fixture('sub dir'), {recursive: true});
	fs.mkdirSync(fixture('.ssh'), {recursive: true});
	fs.writeFileSync(fixture('photo.png'), pngBytes);
	fs.writeFileSync(fixture('sub dir', 'my photo.png'), pngBytes);
	fs.writeFileSync(fixture('clip.mp4'), mp4Bytes);
	fs.writeFileSync(fixture('document.pdf'), '%PDF-1.4 fake');
	fs.writeFileSync(
		fixture('key-as.jpg'),
		'-----BEGIN OPENSSH PRIVATE KEY-----',
	);
	fs.writeFileSync(fixture('.ssh', 'id_rsa'), 'fake key');
});

test.after.always(() => {
	fs.rmSync(root, {recursive: true, force: true});
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockThread = {
	id: 'thread_1',
	title: 'Test Thread',
	users: [],
	lastActivity: new Date(),
	unread: false,
};

type Calls = {
	photos: PreparedMedia[];
	videos: PreparedMedia[];
	replies: string[];
};

function makeContext(overrides?: Partial<ChatState>): {
	context: ChatCommandContext;
	calls: Calls;
} {
	const calls: Calls = {photos: [], videos: [], replies: []};
	const client = {
		async sendPhoto(_threadId: string, media: PreparedMedia) {
			calls.photos.push(media);
			return 'photo_item';
		},
		async sendVideo(_threadId: string, media: PreparedMedia) {
			calls.videos.push(media);
			return 'video_item';
		},
		async sendReply(_threadId: string, text: string) {
			calls.replies.push(text);
			return 'reply_item';
		},
	} as unknown as InstagramClient;

	const context: ChatCommandContext = {
		client,
		chatState: {
			messages: [],
			currentThread: mockThread,
			isSelectionMode: false,
			selectedMessageIndex: undefined,
			threads: [mockThread],
			loading: false,
			recipientAlreadyRead: false,
			...overrides,
		},
		setChatState() {},
		height: 24,
		scrollViewRef: {current: undefined},
	};
	return {context, calls};
}

const uploadHandler = chatCommands['upload']!.handler;
const replyHandler = chatCommands['reply']!.handler;

// ── :upload ──────────────────────────────────────────────────────────────────

test(':upload with plain absolute path uploads image', async t => {
	const {context, calls} = makeContext();
	const result = await uploadHandler([fixture('photo.png')], context);
	t.is(result, 'Image uploaded: photo.png');
	t.is(calls.photos.length, 1);
	t.is(calls.photos[0]!.mime, 'image/png');
});

test(':upload with spaced path uploads image', async t => {
	// The command parser splits on whitespace, so the path arrives in parts
	const {context, calls} = makeContext();
	const parts = fixture('sub dir', 'my photo.png').split(' ');
	const result = await uploadHandler(parts, context);
	t.is(result, 'Image uploaded: my photo.png');
	t.is(calls.photos.length, 1);
});

test(':upload with double-quoted path strips quotes and uploads', async t => {
	const {context} = makeContext();
	const result = await uploadHandler([`"${fixture('photo.png')}"`], context);
	t.is(result, 'Image uploaded: photo.png');
});

test(':upload with single-quoted path strips quotes and uploads', async t => {
	const {context} = makeContext();
	const result = await uploadHandler([`'${fixture('photo.png')}'`], context);
	t.is(result, 'Image uploaded: photo.png');
});

test(':upload with #-prefixed path strips hash and uploads', async t => {
	// Autocomplete inserts a '#' prefix
	const {context} = makeContext();
	const result = await uploadHandler([`#${fixture('photo.png')}`], context);
	t.is(result, 'Image uploaded: photo.png');
});

test(':upload detects video by content and uploads video', async t => {
	const {context, calls} = makeContext();
	const result = await uploadHandler([fixture('clip.mp4')], context);
	t.is(result, 'Video uploaded: clip.mp4');
	t.is(calls.videos.length, 1);
	t.is(calls.photos.length, 0);
});

test(':upload refuses unsupported file types', async t => {
	const {context, calls} = makeContext();
	const result = await uploadHandler([fixture('document.pdf')], context);
	t.true(typeof result === 'string' && result.startsWith('Upload blocked:'));
	t.is(calls.photos.length + calls.videos.length, 0);
});

test(':upload refuses a key disguised with an image extension', async t => {
	const {context, calls} = makeContext();
	const result = await uploadHandler([fixture('key-as.jpg')], context);
	t.true(typeof result === 'string' && result.startsWith('Upload blocked:'));
	t.is(calls.photos.length, 0);
});

test(':upload refuses sensitive files without leaking the path', async t => {
	const {context, calls} = makeContext();
	const result = await uploadHandler([fixture('.ssh', 'id_rsa')], context);
	t.true(typeof result === 'string' && result.includes('protected location'));
	t.false(String(result).includes(root));
	t.is(calls.photos.length + calls.videos.length, 0);
});

test(':upload reports missing files', async t => {
	const {context} = makeContext();
	const result = await uploadHandler([fixture('missing.png')], context);
	t.is(result, 'Upload blocked: "missing.png" was not found.');
});

test(':upload with no arguments returns usage hint', async t => {
	const {context} = makeContext();
	const result = await uploadHandler([], context);
	t.is(result, 'Usage: :upload <path-to-file>');
});

test(':upload without active thread returns undefined', async t => {
	const {context} = makeContext({currentThread: undefined});
	const result = await uploadHandler([fixture('photo.png')], context);
	t.is(result, undefined);
});

// ── :reply ───────────────────────────────────────────────────────────────────

const replyTarget: Message = {
	id: 'item_1',
	timestamp: new Date(),
	userId: 'other',
	username: 'other',
	isOutgoing: false,
	threadId: 'thread_1',
	itemType: 'text',
	text: 'hi',
};

test(':reply refuses attachment tokens and sends nothing', async t => {
	const {context, calls} = makeContext({
		messages: [replyTarget],
		selectedMessageIndex: 0,
	});
	const result = await replyHandler(
		['see', `#${fixture('photo.png')}`],
		context,
	);
	t.true(String(result).startsWith('Attachments are not supported in :reply'));
	t.deepEqual(calls.replies, []);
});

test(':reply sends text with emoji shortcodes', async t => {
	const {context, calls} = makeContext({
		messages: [replyTarget],
		selectedMessageIndex: 0,
	});
	await replyHandler(['thanks', ':heart:'], context);
	t.is(calls.replies.length, 1);
	t.false(calls.replies[0]!.includes(':heart:'));
});
