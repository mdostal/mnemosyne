import {
  AllRunnersUnavailableError,
  RunnerUnavailableError,
  type RunnerFailure,
} from '../errors/RunnerUnavailableError.js';
import { logger as defaultLogger, type Logger } from '../observability/logger.js';
import {
  recordRunnerMetric as defaultMetricsRecorder,
  type RunnerMetricEvent,
} from '../observability/metrics.js';

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
  fallbackEnabled?: boolean;
  runnerPriorities?: Partial<Record<RunnerName, number>>;
  logger?: Logger;
  metricsRecorder?: (event: RunnerMetricEvent) => void | Promise<void>;
}

const DEFAULT_RUNNER_PRIORITY: Record<'claude' | 'codex' | 'gemini', number> = {
  claude: 10,
  codex: 20,
  gemini: 30,
};

export class RunnerChain<TPrompt, TContext, TResult> {
  private readonly runners: readonly PlanningRunner<TPrompt, TContext, TResult>[];
  private readonly onFallback?: RunnerChainOptions['onFallback'];
  private readonly fallbackEnabled: boolean;
  private readonly logger: Logger;
  private readonly metricsRecorder: (event: RunnerMetricEvent) => void | Promise<void>;

  constructor(
    runners: readonly PlanningRunner<TPrompt, TContext, TResult>[],
    options: RunnerChainOptions = {},
  ) {
    const configuredPriorities = options.runnerPriorities ?? {};
    this.runners = [...runners]
      .map((runner, index) => ({ runner, index }))
      .sort((left, right) => {
        const leftPriority = runnerPriority(left.runner, configuredPriorities);
        const rightPriority = runnerPriority(right.runner, configuredPriorities);
        return leftPriority - rightPriority || left.index - right.index;
      })
      .map(({ runner }) => runner);
    this.fallbackEnabled = options.fallbackEnabled ?? true;
    this.logger = options.logger ?? defaultLogger;
    this.metricsRecorder = options.metricsRecorder ?? defaultMetricsRecorder;

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

      const nextRunner = this.fallbackEnabled ? this.runners[index + 1]?.name ?? null : null;
      let available: boolean;

      try {
        available = await runner.isAvailable();
      } catch (error) {
        if (!(error instanceof RunnerUnavailableError)) {
          throw error;
        }

        const failure = failureFromUnavailableError(runner.name, 'availability', error);
        failures.push(failure);
        await this.recordFailure(failure);
        await this.logFallback(failure, nextRunner);
        if (!this.fallbackEnabled) {
          throw unavailableErrorFromFailure(failure);
        }
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
        await this.recordFailure(failure);
        await this.logFallback(failure, nextRunner);
        if (!this.fallbackEnabled) {
          throw unavailableErrorFromFailure(failure);
        }
        continue;
      }

      await this.recordAttempt(runner.name);
      const startedAt = Date.now();

      try {
        const result = await runner.invoke(prompt, context);
        await this.recordSuccess(runner.name, Date.now() - startedAt);
        return result;
      } catch (error) {
        if (!(error instanceof RunnerUnavailableError)) {
          throw error;
        }

        const failure = failureFromUnavailableError(runner.name, 'invoke', error);
        failures.push(failure);
        await this.recordFailure(failure);
        await this.logFallback(failure, nextRunner);
        if (!this.fallbackEnabled) {
          throw unavailableErrorFromFailure(failure);
        }
      }
    }

    throw new AllRunnersUnavailableError(failures);
  }

  private async recordAttempt(runner: RunnerName): Promise<void> {
    const timestamp = new Date().toISOString();
    this.logger.info('runner_attempt', { runner, timestamp });
    await this.metricsRecorder({ event: 'runner_attempt', runner: String(runner), timestamp });
  }

  private async recordSuccess(runner: RunnerName, latencyMs: number): Promise<void> {
    const timestamp = new Date().toISOString();
    this.logger.info('runner_success', { runner, latencyMs, timestamp });
    await this.metricsRecorder({
      event: 'runner_success',
      runner: String(runner),
      latencyMs,
      timestamp,
    });
  }

  private async recordFailure(failure: RunnerFailure): Promise<void> {
    const timestamp = new Date().toISOString();
    this.logger.error('runner_failure', {
      runner: failure.runner,
      phase: failure.phase,
      reason: failure.reason,
      code: failure.code,
      timestamp,
    });
    await this.metricsRecorder({
      event: 'runner_failure',
      runner: failure.runner,
      phase: failure.phase,
      reason: failure.reason,
      code: failure.code,
      timestamp,
    });
  }

  private async logFallback(
    failure: RunnerFailure,
    nextRunner: RunnerFallbackEvent['next_runner'],
  ): Promise<void> {
    const event: RunnerFallbackEvent = {
      runner: failure.runner,
      phase: failure.phase,
      reason: failure.reason,
      next_runner: nextRunner,
    };

    if (failure.code !== undefined) {
      event.code = failure.code;
    }

    if (nextRunner !== null) {
      const timestamp = new Date().toISOString();
      this.logger.warn('fallback_triggered', { ...event, timestamp });
      await this.metricsRecorder({
        event: 'fallback_triggered',
        runner: event.runner,
        phase: event.phase,
        reason: event.reason,
        next_runner: event.next_runner,
        code: event.code,
        timestamp,
      });
    }

    if (this.onFallback !== undefined) {
      await this.onFallback(event);
    }
  }
}

function runnerPriority<TPrompt, TContext, TResult>(
  runner: PlanningRunner<TPrompt, TContext, TResult>,
  configuredPriorities: Partial<Record<RunnerName, number>>,
): number {
  return runner.priority ?? configuredPriorities[runner.name] ?? defaultPriority(runner.name);
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

function unavailableErrorFromFailure(failure: RunnerFailure): RunnerUnavailableError {
  const options: { runner: string; code?: string } = {
    runner: failure.runner,
  };

  if (failure.code !== undefined) {
    options.code = failure.code;
  }

  return new RunnerUnavailableError(failure.reason, options);
}
