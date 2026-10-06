import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import yaml from 'js-yaml';
import {createContextualLogger} from './utils/logger.js';

type LoginConfig = {
	defaultUsername?: string;
	currentUsername?: string;
};

type ChatConfig = {
	layout: string;
	colors: boolean;
};

type PrivacyConfig = {
	invisibleMode: boolean;
};

type NotificationsConfig = {
	desktop: boolean;
	sound: boolean;
};

type ImageConfig = {
	protocol?: string;
};

type AdvancedConfig = {
	debugMode: boolean;
	dataDir: string;
	usersDir: string;
	cacheDir: string;
	mediaDir: string;
	generatedDir: string;
	logsDir: string;
	downloadDir: string;
};

type Config = {
	language: string;
	login: LoginConfig;
	chat: ChatConfig;
	privacy: PrivacyConfig;
	notifications: NotificationsConfig;
	image: ImageConfig;
	advanced: AdvancedConfig;
};

/**
 * Environment variable that relocates all CLI state (config, sessions, logs, cache).
 * Used by the test suite to keep automated runs away from real user data.
 */
export const DATA_DIR_ENV_VAR = 'INSTAGRAM_CLI_HOME';

/**
 * Resolves the root directory for all CLI state.
 *
 * @param environment - Environment to read the override from (injectable for tests).
 * @returns The absolute data directory, defaulting to `~/.instagram-cli`.
 */
export function resolveDataDir(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const override = environment[DATA_DIR_ENV_VAR]?.trim();
	if (override) {
		return path.resolve(override);
	}

	return path.join(os.homedir(), '.instagram-cli');
}

const createDefaultConfig = (dataDir: string): Config => ({
	language: 'en',
	login: {
		defaultUsername: undefined,
		currentUsername: undefined,
	},
	chat: {
		layout: 'compact',
		colors: true,
	},
	privacy: {
		invisibleMode: false,
	},
	notifications: {
		desktop: false,
		sound: false,
	},
	advanced: {
		debugMode: false,
		dataDir,
		usersDir: path.join(dataDir, 'users'),
		cacheDir: path.join(dataDir, 'cache'),
		mediaDir: path.join(dataDir, 'media'),
		generatedDir: path.join(dataDir, 'generated'),
		logsDir: path.join(dataDir, 'logs'),
		downloadDir: path.join(dataDir, 'downloads'),
	},
	image: {},
});

export class ConfigManager {
	public static getInstance(): ConfigManager {
		ConfigManager.instance ||= new ConfigManager();
		return ConfigManager.instance;
	}

	private static instance: ConfigManager;
	private config: Config;
	// Resolved at construction (not import) so the data dir override is honored
	private readonly defaultConfig: Config;
	private readonly configDir: string;
	private readonly configFile: string;
	private readonly logger = createContextualLogger('ConfigManager');

	private constructor() {
		this.defaultConfig = createDefaultConfig(resolveDataDir());
		this.configDir = this.defaultConfig.advanced.dataDir;
		this.configFile = path.join(this.configDir, 'config.ts.yaml');
		this.config = {...this.defaultConfig};
	}

	public getConfigFilePath(): string {
		return this.configFile;
	}

	public async initialize(): Promise<void> {
		await this.loadConfig();
	}

	public get<T = string>(keyPath: string, defaultValue?: T): T {
		const keys = keyPath.split('.');
		let value: any = this.config;

		for (const key of keys) {
			if (value && typeof value === 'object' && key in value) {
				value = value[key];
			} else {
				return defaultValue as T;
			}
		}

		return value as T;
	}

	public async set(keyPath: string, value: any): Promise<void> {
		const keys = keyPath.split('.');
		let current: any = this.config;

		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i];
			if (key && !(key in current)) {
				current[key] = {};
			}

			if (key) {
				current = current[key];
			}
		}

		const lastKey = keys.at(-1);
		if (lastKey) {
			current[lastKey] = value;
		}

		await this.saveConfig();
	}

	public getConfig(): Config {
		return {...this.config};
	}

	private async loadConfig(): Promise<void> {
		try {
			await fs.mkdir(this.configDir, {recursive: true});

			const configExists = await fs
				.access(this.configFile)
				.then(() => true)
				.catch(() => false);

			if (configExists) {
				const configData = await fs.readFile(this.configFile, 'utf8');
				const loadedConfig = yaml.load(configData) as Partial<Config>;
				this.config = this.mergeConfig(this.defaultConfig, loadedConfig);
			} else {
				await this.saveConfig();
			}
		} catch (error) {
			this.logger.error('Error loading config:', error);
			this.config = {...this.defaultConfig};
		}
	}

	private mergeConfig(
		defaultConfig: Config,
		loadedConfig: Partial<Config>,
	): Config {
		return {
			...defaultConfig,
			...loadedConfig,
			login: {...defaultConfig.login, ...loadedConfig.login},
			chat: {...defaultConfig.chat, ...loadedConfig.chat},
			privacy: {...defaultConfig.privacy, ...loadedConfig.privacy},
			notifications: {
				...defaultConfig.notifications,
				...loadedConfig.notifications,
			},
			image: {...defaultConfig.image, ...loadedConfig.image},
			advanced: {...defaultConfig.advanced, ...loadedConfig.advanced},
		};
	}

	private async saveConfig(): Promise<void> {
		try {
			await fs.mkdir(this.configDir, {recursive: true});
			const yamlContent = yaml.dump(this.config);
			await fs.writeFile(this.configFile, yamlContent, 'utf8');
		} catch (error) {
			this.logger.error('Error saving config:', error);
		}
	}
}
