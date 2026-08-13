import { describe, expect, it } from 'vitest';
import type { PlanResponse } from '../../types/PlanResponse.js';
import {
  RunnerStrategy,
  RunnerUnavailableError,
  sortRunnerStrategies,
  type RunnerInvocationContext,
} from '../RunnerStrategy.js';

const validPlan = {
  summary: 'Ship runner strategy',
  steps: [
    {
      id: 'define-contract',
      title: 'Define contract',
      description: 'Create the base runner strategy contract',
    },
  ],
};

class TestRunner extends RunnerStrategy {
  readonly name: string;
  readonly priority: number;
  readonly response: unknown;
  readonly available: boolean;
  lastInvocation?: { prompt: string; context?: RunnerInvocationContext };

  constructor(options: {
    name?: string;
    priority?: number;
    response?: unknown;
    available?: boolean;
  } = {}) {
    super();
    this.name = options.name ?? 'test';
    this.priority = options.priority ?? 2;
    this.response = options.response ?? validPlan;
    this.available = options.available ?? true;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async invoke(prompt: string, context?: RunnerInvocationContext): Promise<PlanResponse> {
    this.lastInvocation = context === undefined ? { prompt } : { prompt, context };
    this.assertAvailable(await this.isAvailable());
    return this.validatePlanResponse(this.response);
  }

  makeUnavailableError(cause: unknown): RunnerUnavailableError {
    return this.unavailable('test runner unavailable', {
      code: 'test_unavailable',
      cause,
    });
  }
}

describe('RunnerStrategy', () => {
  it('Given a runner implementation, when invoke() is called, then it returns a validated PlanResponse', async () => {
    const runner = new TestRunner({
      response: {
        ...validPlan,
        ignored_extra_field: true,
      },
    });

    await expect(
      runner.invoke('Plan the work', {
        metricName: 'runner_strategy_test',
        metadata: { ticket: 'PAN-7786' },
      }),
    ).resolves.toEqual(validPlan);
    expect(runner.lastInvocation?.prompt).toBe('Plan the work');
  });

  it('Given a runner returns an invalid response, when invoke() validates it, then validation fails', async () => {
    const runner = new TestRunner({
      response: {
        summary: 'missing steps',
      },
    });

    await expect(runner.invoke('Plan the work')).rejects.toThrow(
      'PlanResponse.steps must be a non-empty array',
    );
  });

  it('Given a runner is unavailable, when invoke() checks availability, then it throws a structured unavailable error', async () => {
    const runner = new TestRunner({ available: false });

    await expect(runner.invoke('Plan the work')).rejects.toMatchObject({
      name: 'RunnerUnavailableError',
      runner: 'test',
      code: 'runner_unavailable',
    });
  });

  it('Given multiple runners, when sorted by priority, then 1 is primary before 2 and 3', () => {
    const tertiary = new TestRunner({ name: 'tertiary', priority: 3 });
    const primary = new TestRunner({ name: 'primary', priority: 1 });
    const fallback = new TestRunner({ name: 'fallback', priority: 2 });

    expect(sortRunnerStrategies([tertiary, primary, fallback]).map((runner) => runner.name)).toEqual([
      'primary',
      'fallback',
      'tertiary',
    ]);
  });

  it('Given equal priorities, when sorted, then original order is preserved', () => {
    const first = new TestRunner({ name: 'first', priority: 2 });
    const second = new TestRunner({ name: 'second', priority: 2 });

    expect(sortRunnerStrategies([first, second]).map((runner) => runner.name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('Given a concrete runner helper creates unavailable errors, then runner identity and cause are retained', () => {
    const cause = new Error('health check failed');
    const runner = new TestRunner();
    const error = runner.makeUnavailableError(cause);

    expect(error).toBeInstanceOf(RunnerUnavailableError);
    expect(error).toMatchObject({
      name: 'RunnerUnavailableError',
      runner: 'test',
      code: 'test_unavailable',
      cause,
    });
  });
});
