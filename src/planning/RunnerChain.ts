import {
  AllRunnersUnavailableError,
  RunnerUnavailableError,
  type RunnerFailure,
} from '../errors/RunnerUnavailableError.js';

export type RunnerName = 'claude' | 'codex' | 'gemini' | (string & {});

export interface PlanningRunner<TPrompt, TContext, TResult> {
  name: RunnerName;
  priority?: number;
  isAvailable: () => boolean | Promise<boolean>;
  invoke: (prompt: TPrompt, context: TContext) => TResult | Promise<TResult>;
}

export interface RunnerFallbackEvent {
  runner: string;
  phase: RunnerFailure['phase'];
  reason: string;
  next_runner: string | null;
  code?: string;
}

export interface RunnerChainOptions {
  onFallback?: (event: RunnerFallbackEvent) => void | Promise<void>;
}

const DEFAULT_RUNNER_PRIORITY: Record<'claude' | 'codex' | 'gemini', number> = {
  claude: 10,
  codex: 20,
  gemini: 30,
};

export class RunnerChain<TPrompt, TContext, TResult> {
  private readonly runners: readonly PlanningRunner<TPrompt, TContext, TResult>[];
  private readonly onFallback?: RunnerChainOptions['onFallback'];

  constructor(
    runners: readonly PlanningRunner<TPrompt, TContext, TResult>[],
    options: RunnerChainOptions = {},
  ) {
    this.runners = [...runners].sort((left, right) => {
      const leftPriority = left.priority ?? defaultPriority(left.name);
      const rightPriority = right.priority ?? defaultPriority(right.name);
      return leftPriority - rightPriority;
    });

    if (options.onFallback !== undefined) {
      this.onFallback = options.onFallback;
    }
  }

  async plan(prompt: TPrompt, context: TContext): Promise<TResult> {
    const failures: RunnerFailure[] = [];

    for (let index = 0; index < this.runners.length; index += 1) {
      const runner = this.runners[index];
      if (runner === undefined) {
        continue;
      }

      const nextRunner = this.runners[index + 1]?.name ?? null;
      let available: boolean;

      try {
        available = await runner.isAvailable();
      } catch (error) {
        if (!(error instanceof RunnerUnavailableError)) {
          throw error;
        }

        const failure = failureFromUnavailableError(runner.name, 'availability', error);
        failures.push(failure);
        await this.logFallback(failure, nextRunner);
        continue;
      }

      if (!available) {
        const failure = {
          runner: runner.name,
          phase: 'availability' as const,
          reason: 'isAvailable returned false',
          code: 'runner_unavailable',
        };
        failures.push(failure);
        await this.logFallback(failure, nextRunner);
        continue;
      }

      try {
        return await runner.invoke(prompt, context);
      } catch (error) {
        if (!(error instanceof RunnerUnavailableError)) {
          throw error;
        }

        const failure = failureFromUnavailableError(runner.name, 'invoke', error);
        failures.push(failure);
        await this.logFallback(failure, nextRunner);
      }
    }

    throw new AllRunnersUnavailableError(failures);
  }

  private async logFallback(
    failure: RunnerFailure,
    nextRunner: RunnerFallbackEvent['next_runner'],
  ): Promise<void> {
    if (this.onFallback === undefined) {
      return;
    }

    const event: RunnerFallbackEvent = {
      runner: failure.runner,
      phase: failure.phase,
      reason: failure.reason,
      next_runner: nextRunner,
    };

    if (failure.code !== undefined) {
      event.code = failure.code;
    }

    await this.onFallback(event);
  }
}

function defaultPriority(name: RunnerName): number {
  switch (name) {
    case 'claude':
      return DEFAULT_RUNNER_PRIORITY.claude;
    case 'codex':
      return DEFAULT_RUNNER_PRIORITY.codex;
    case 'gemini':
      return DEFAULT_RUNNER_PRIORITY.gemini;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function failureFromUnavailableError(
  runner: RunnerName,
  phase: RunnerFailure['phase'],
  error: RunnerUnavailableError,
): RunnerFailure {
  const failure: RunnerFailure = {
    runner: error.runner ?? runner,
    phase,
    reason: error.message,
    code: error.code,
  };

  return failure;
}
