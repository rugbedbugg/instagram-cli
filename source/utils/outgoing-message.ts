import type {InstagramClient} from '../client.js';
import {getEmojiByName} from './emoji.js';
import {
	approveLocalFile,
	LocalFileError,
	readAttachment,
	readMediaForUpload,
	type ApprovedLocalFile,
	type MediaKind,
	type FileAccessOptions,
	type PreparedAttachment,
} from './local-file-policy.js';

/**
 * Outgoing chat messages with explicit `#path` attachments.
 *
 * A `#` token is an attachment request only when it starts a word and looks
 * like a path (contains `/`, `\` or `.`, or starts with `~`). Quoted forms
 * `#"a b.txt"` and `#'a b.txt'` allow spaces. `\#` sends a literal `#`.
 *
 * Attachments are never read while planning: planning only approves paths.
 * The chat UI must get explicit confirmation before sendPlannedMessage reads
 * and transmits anything. Any rejected attachment rejects the whole message,
 * so neither the file nor the path text is ever sent.
 */

export const maxAttachmentsPerMessage = 10;

export type AttachmentToken = {
	/** Path exactly as written after `#`, without quotes. */
	readonly requestedPath: string;
	readonly start: number;
	readonly end: number;
};

export type ParsedOutgoingMessage = {
	/** Message text with attachment tokens removed and `\#` unescaped. */
	readonly text: string;
	readonly attachments: readonly AttachmentToken[];
};

const tokenPattern = /(?<=^|\s)(\\)?#(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"']\S*))/g;
const trailingPunctuation = /[)\]>.,!?;:]+$/;

function looksLikePath(candidate: string): boolean {
	return candidate.startsWith('~') || /[./\\]/.test(candidate);
}

/** Splits attachment tokens out of a message. Pure: no filesystem access. */
export function parseOutgoingMessage(input: string): ParsedOutgoingMessage {
	const attachments: AttachmentToken[] = [];

	for (const match of input.matchAll(tokenPattern)) {
		const [whole, escaped, doubleQuoted, singleQuoted, unquoted] = match;
		if (escaped) continue;

		const start = match.index;
		let requestedPath: string;
		let end: number;
		if (doubleQuoted !== undefined || singleQuoted !== undefined) {
			requestedPath = doubleQuoted ?? singleQuoted ?? '';
			end = start + whole.length;
		} else {
			requestedPath = (unquoted ?? '').replace(trailingPunctuation, '');
			end = start + 1 + requestedPath.length;
		}

		if (requestedPath.length === 0 || !looksLikePath(requestedPath)) {
			continue;
		}

		attachments.push({requestedPath, start, end});
	}

	return {text: removeTokens(input, attachments), attachments};
}

/**
 * Removes each token plus one adjacent whitespace character, so
 * "before #a.txt after" becomes "before after" and "#a.txt hi" becomes "hi".
 */
function removeTokens(
	input: string,
	tokens: readonly AttachmentToken[],
): string {
	const ranges = tokens.map(({start, end}) => {
		if (start > 0 && /\s/.test(input[start - 1]!)) {
			return [start - 1, end] as const;
		}

		return [start, /\s/.test(input[end] ?? '') ? end + 1 : end] as const;
	});

	let result = '';
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start > cursor) {
			result += input.slice(cursor, start);
		}

		cursor = Math.max(cursor, end);
	}

	result += input.slice(cursor);
	return result.replaceAll(/(^|\s)\\#/g, '$1#').trim();
}

/** Replaces `:emoji_name:` shortcodes with emoji. */
export function applyEmojiShortcodes(text: string): string {
	// eslint-disable-next-line unicorn/prefer-string-replace-all
	return text.replace(
		/:(\w+):/g,
		(_, name: string) => getEmojiByName(name) ?? `:${name}:`,
	);
}

export type PlannedAttachment = {
	readonly displayName: string;
	readonly size: number;
	readonly file: ApprovedLocalFile;
};

export type OutgoingMessagePlan =
	| {
			readonly status: 'ready';
			readonly text: string;
			readonly attachments: readonly PlannedAttachment[];
	  }
	| {
			readonly status: 'rejected';
			readonly errors: readonly string[];
	  };

/**
 * Parses a message and approves every attachment path without reading content.
 * Returns `rejected` with local, path-free error messages if any attachment
 * cannot be used, in which case nothing must be sent.
 */
export async function planOutgoingMessage(
	input: string,
	options: FileAccessOptions = {},
): Promise<OutgoingMessagePlan> {
	const parsed = parseOutgoingMessage(input);
	const text = applyEmojiShortcodes(parsed.text);

	if (parsed.attachments.length > maxAttachmentsPerMessage) {
		return {
			status: 'rejected',
			errors: [
				`Too many attachments (${parsed.attachments.length}); the limit is ${maxAttachmentsPerMessage} per message.`,
			],
		};
	}

	const attachments: PlannedAttachment[] = [];
	const errors: string[] = [];
	for (const token of parsed.attachments) {
		try {
			// eslint-disable-next-line no-await-in-loop
			const file = await approveLocalFile(
				token.requestedPath,
				'attachment',
				options,
			);
			attachments.push({
				displayName: file.displayName,
				size: file.size,
				file,
			});
		} catch (error) {
			errors.push(
				error instanceof LocalFileError
					? error.message
					: 'An attachment could not be checked.',
			);
		}
	}

	if (errors.length > 0) {
		return {status: 'rejected', errors};
	}

	return {status: 'ready', text, attachments};
}

export type ReadyOutgoingMessagePlan = Extract<
	OutgoingMessagePlan,
	{status: 'ready'}
>;

export type MessageSender = Pick<InstagramClient, 'sendMessage' | 'sendPhoto'>;
export type MediaSender = Pick<InstagramClient, 'sendPhoto' | 'sendVideo'>;

export type SendResult = {
	readonly photosSent: number;
	readonly text: string | undefined;
};

/**
 * Reads and validates every attachment first, then transmits photos followed
 * by the text (with embedded text files appended under their base names).
 * If any attachment fails validation, it throws before anything is sent.
 */
export async function sendPlannedMessage(
	plan: ReadyOutgoingMessagePlan,
	client: MessageSender,
	threadId: string,
): Promise<SendResult> {
	const prepared: PreparedAttachment[] = [];
	for (const attachment of plan.attachments) {
		// eslint-disable-next-line no-await-in-loop
		prepared.push(await readAttachment(attachment.file));
	}

	let {text} = plan;
	for (const item of prepared) {
		if (item.type === 'text') {
			const block = `--- ${item.displayName} ---\n${item.text}`;
			text = text ? `${text}\n${block}` : block;
		}
	}

	let photosSent = 0;
	for (const item of prepared) {
		if (item.type === 'photo') {
			// eslint-disable-next-line no-await-in-loop
			await client.sendPhoto(threadId, item.media);
			photosSent++;
		}
	}

	const finalText = text.trim();
	if (finalText) {
		await client.sendMessage(threadId, finalText);
	}

	return {photosSent, text: finalText || undefined};
}

export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type MediaUploadResult = {
	readonly kind: MediaKind;
	readonly displayName: string;
	readonly messageId: string;
};

/**
 * Explicit media upload (`:upload`, `send --file`). The command itself is the
 * user's explicit intent, so there is no confirmation prompt, but the file
 * still passes the full local file policy and must really be an image or
 * video by content. Throws LocalFileError when the file is refused.
 */
export async function uploadLocalMedia(
	client: MediaSender,
	threadId: string,
	requestedPath: string,
	requestedKind: MediaKind | 'auto' = 'auto',
	options: FileAccessOptions = {},
): Promise<MediaUploadResult> {
	const file = await approveLocalFile(requestedPath, 'media-upload', options);
	const media = await readMediaForUpload(file, requestedKind);
	const messageId =
		media.kind === 'photo'
			? await client.sendPhoto(threadId, media)
			: await client.sendVideo(threadId, media);
	return {kind: media.kind, displayName: media.displayName, messageId};
}
