import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadRunnerConfig,
  resolveRunnerApiKey,
  runnerConfigToChainOptions,
} from '../RunnerConfig.js';

async function withConfigFile(source: string, test: (configPath: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-runner-config-'));
  try {
    const configPath = path.join(dir, 'minerva.config.yaml');
    await writeFile(configPath, source, 'utf8');
    await test(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('RunnerConfig', () => {
  it('Given config file exists, when driver initializes, then it reads API keys from config', async () => {
    await withConfigFile(
      `
runners:
  claude:
    api_key: config-anthropic-key
`,
      async (configPath) => {
        const config = await loadRunnerConfig({
          configPath,
          env: {},
        });

        expect(resolveRunnerApiKey('claude', config, { env: {} })).toBe('config-anthropic-key');
      },
    );
  });

  it('Given ANTHROPIC_API_KEY env var is set, when driver initializes, then env var takes precedence over config file', async () => {
    await withConfigFile(
      `
runners:
  claude:
    api_key: config-anthropic-key
`,
      async (configPath) => {
        const config = await loadRunnerConfig({
          configPath,
          env: {
            ANTHROPIC_API_KEY: 'env-anthropic-key',
          },
        });

        expect(
          resolveRunnerApiKey('claude', config, {
            env: {
              ANTHROPIC_API_KEY: 'env-anthropic-key',
            },
          }),
        ).toBe('env-anthropic-key');
      },
    );
  });

  it('Given runner priority and fallback are overridden in config, when chain options are built, then custom preferences are used', async () => {
    await withConfigFile(
      `
runners:
  fallback:
    enabled: false
  claude:
    priority: 50
  codex:
    priority: 5
`,
      async (configPath) => {
        const config = await loadRunnerConfig({
          configPath,
          env: {},
        });

        expect(runnerConfigToChainOptions(config)).toEqual({
          fallbackEnabled: false,
          runnerPriorities: {
            claude: 50,
            codex: 5,
          },
        });
      },
    );
  });
});
