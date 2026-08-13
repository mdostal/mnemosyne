import {
  RunnerUnavailableError,
  type RunnerUnavailableOptions,
} from '../errors/RunnerUnavailableError.js';
import { validatePlanResponse, type PlanResponse } from '../types/PlanResponse.js';

export { RunnerUnavailableError } from '../errors/RunnerUnavailableError.js';

export interface RunnerInvocationContext {
  metricName?: string;
  metadata?: Record<string, unknown>;
}

export interface RunnerStrategyContract {
  readonly name: string;
  readonly priority: number;

  isAvailable(): boolean | Promise<boolean>;

  invoke(prompt: string, context?: RunnerInvocationContext): Promise<PlanResponse>;
}

export abstract class RunnerStrategy implements RunnerStrategyContract {
  abstract readonly name: string;
  abstract readonly priority: number;

  abstract isAvailable(): boolean | Promise<boolean>;

  abstract invoke(prompt: string, context?: RunnerInvocationContext): Promise<PlanResponse>;

  protected validatePlanResponse(value: unknown): PlanResponse {
    return validatePlanResponse(value);
  }

  protected unavailable(
    message = `${this.name} runner is unavailable`,
    options: Omit<RunnerUnavailableOptions, 'runner'> = {},
  ): RunnerUnavailableError {
    const errorOptions: RunnerUnavailableOptions = { runner: this.name };

    if (options.code !== undefined) {
      errorOptions.code = options.code;
    }

    if (options.cause !== undefined) {
      errorOptions.cause = options.cause;
    }

    return new RunnerUnavailableError(message, errorOptions);
  }

  protected assertAvailable(available: boolean, message?: string): void {
    if (!available) {
      throw this.unavailable(message);
    }
  }
}

export function sortRunnerStrategies<T extends RunnerStrategyContract>(runners: readonly T[]): T[] {
  return [...runners]
    .map((runner, index) => ({ runner, index }))
    .sort((left, right) => left.runner.priority - right.runner.priority || left.index - right.index)
    .map(({ runner }) => runner);
}
