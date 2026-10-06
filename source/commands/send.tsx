import React, {useCallback} from 'react';
import zod from 'zod';
import {argument, option} from 'pastel';
import {
	OneTurnCommand,
	outputJson,
	jsonSuccess,
	outputText,
	resolveThread,
} from '../utils/one-turn.js';
import {type InstagramClient} from '../client.js';
import {uploadLocalMedia} from '../utils/outgoing-message.js';

export const description = 'Send a text message, photo, or video to a user';

export const args = zod.tuple([
	zod.string().describe(
		argument({
			name: 'thread',
			description: 'Thread ID, username, or thread title',
		}),
	),
]);

export const options = zod.object({
	username: zod
		.string()
		.optional()
		.describe(
			option({
				alias: 'u',
				description: 'Account username to use',
			}),
		),
	output: zod
		.string()
		.optional()
		.describe(
			option({
				alias: 'o',
				description: 'Output format (json)',
			}),
		),
	text: zod
		.string()
		.optional()
		.describe(
			option({
				alias: 't',
				description: 'Message text to send (omit when using --file)',
			}),
		),
	file: zod
		.string()
		.optional()
		.describe(
			option({
				description: 'Path to a media file to send (photo or video)',
			}),
		),
	type: zod
		.enum(['photo', 'video'])
		.optional()
		.describe(
			option({
				description:
					'Expected media type (photo|video); must match the file content. Auto-detected if omitted',
			}),
		),
});

type Properties = {
	readonly args: zod.infer<typeof args>;
	readonly options: zod.infer<typeof options>;
};

export default function Send({args: commandArgs, options}: Properties) {
	const run = useCallback(
		async (client: InstagramClient) => {
			const [recipient] = commandArgs;
			const isJson = options.output === 'json';

			const {threadId} = await resolveThread(client, recipient);

			if (options.file) {
				// The --file flag is the explicit intent; the local file policy still
				// refuses sensitive files and anything that is not really media.
				const {kind: mediaType, messageId} = await uploadLocalMedia(
					client,
					threadId,
					options.file,
					options.type ?? 'auto',
				);

				if (isJson) {
					outputJson(
						jsonSuccess({
							threadId,
							recipient,
							messageId,
							file: options.file,
							mediaType,
							sent: true,
						}),
					);
				} else {
					const label = mediaType === 'photo' ? 'Photo' : 'Video';
					outputText(`${label} sent to @${recipient}`);
				}

				return;
			}

			if (!options.text) {
				throw new Error(
					'A message is required when not using --file. Usage: send <thread> --text <message>',
				);
			}

			const messageId = await client.sendMessage(threadId, options.text);

			if (isJson) {
				outputJson(jsonSuccess({threadId, recipient, messageId, sent: true}));
			} else {
				outputText(`Message sent to @${recipient}`);
			}
		},
		[commandArgs, options],
	);

	return (
		<OneTurnCommand
			username={options.username}
			output={options.output}
			run={run}
		/>
	);
}
