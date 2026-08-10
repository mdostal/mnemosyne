import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { RunnerChainOptions, RunnerName } from '../planning/RunnerChain.js';

export const DEFAULT_RUNNER_CONFIG_PATH = path.join('config', 'minerva.config.yaml');

export interface RunnerSettings {
  apiKey?: string;
  apiKeyEnv?: string;
  priority?: number;
  enabled: boolean;
}

export interface RunnerConfig {
  runners: Record<string, RunnerSettings>;
  fallback: {
    enabled: boolean;
  };
}

export interface LoadRunnerConfigOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveRunnerApiKeyOptions {
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_API_KEY_ENV: Record<'claude' | 'codex' | 'gemini', readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

export async function loadRunnerConfig(
  options: LoadRunnerConfigOptions = {},
): Promise<RunnerConfig> {
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(options.configPath ?? env.MINERVA_CONFIG_PATH, options.cwd);

  try {
    const raw = await readFile(configPath, 'utf8');
    return parseRunnerConfig(raw, { env });
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultRunnerConfig();
    }

    throw error;
  }
}

export function parseRunnerConfig(
  yamlSource: string,
  _options: ResolveRunnerApiKeyOptions = {},
): RunnerConfig {
  const parsed = parse(yamlSource) as unknown;
  return normalizeRunnerConfig(parsed);
}

export function defaultRunnerConfig(): RunnerConfig {
  return {
    runners: {},
    fallback: {
      enabled: true,
    },
  };
}

export function resolveRunnerApiKey(
  runnerName: RunnerName,
  config: RunnerConfig,
  options: ResolveRunnerApiKeyOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const runner = config.runners[runnerName];
  const envNames = [
    runner?.apiKeyEnv,
    ...defaultApiKeyEnvNames(runnerName),
    `${String(runnerName).toUpperCase()}_API_KEY`,
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);

  for (const envName of envNames) {
    const value = env[envName];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return runner?.apiKey;
}

export function runnerConfigToChainOptions(config: RunnerConfig): RunnerChainOptions {
  const runnerPriorities: Partial<Record<RunnerName, number>> = {};

  for (const [runner, settings] of Object.entries(config.runners)) {
    if (settings.priority !== undefined) {
      runnerPriorities[runner as RunnerName] = settings.priority;
    }
  }

  return {
    fallbackEnabled: config.fallback.enabled,
    runnerPriorities,
  };
}

function normalizeRunnerConfig(parsed: unknown): RunnerConfig {
  const root = asRecord(parsed);
  const rawRunners = asRecord(root.runners);
  const fallbackSection = asRecord(rawRunners.fallback ?? root.fallback);
  const runners: Record<string, RunnerSettings> = {};

  for (const [name, value] of Object.entries(rawRunners)) {
    if (name === 'fallback') {
      continue;
    }

    const rawRunner = asRecord(value);
    const apiKey = readString(rawRunner.apiKey ?? rawRunner.api_key);
    const apiKeyEnv = readString(rawRunner.apiKeyEnv ?? rawRunner.api_key_env);
    const priority = readNumber(rawRunner.priority);
    const enabled = readBoolean(rawRunner.enabled, true);
    const settings: RunnerSettings = { enabled };

    if (apiKey !== undefined) {
      settings.apiKey = apiKey;
    }

    if (apiKeyEnv !== undefined) {
      settings.apiKeyEnv = apiKeyEnv;
    }

    if (priority !== undefined) {
      settings.priority = priority;
    }

    runners[name] = settings;
  }

  return {
    runners,
    fallback: {
      enabled: readBoolean(fallbackSection.enabled, true),
    },
  };
}

function resolveConfigPath(configPath: string | undefined, cwd = process.cwd()): string {
  const requested = configPath ?? DEFAULT_RUNNER_CONFIG_PATH;
  return path.isAbsolute(requested) ? requested : path.join(cwd, requested);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function defaultApiKeyEnvNames(runnerName: RunnerName): readonly string[] {
  switch (runnerName) {
    case 'claude':
      return DEFAULT_API_KEY_ENV.claude;
    case 'codex':
      return DEFAULT_API_KEY_ENV.codex;
    case 'gemini':
      return DEFAULT_API_KEY_ENV.gemini;
    default:
      return [];
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
