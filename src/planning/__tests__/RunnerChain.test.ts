import { describe, expect, it, vi } from 'vitest';
import {
  AllRunnersUnavailableError,
  RunnerUnavailableError,
} from '../../errors/RunnerUnavailableError.js';
import {
  RunnerChain,
  type PlanningRunner,
  type RunnerFallbackEvent,
  type RunnerName,
} from '../RunnerChain.js';

type TestRunner = PlanningRunner<string, { ticket: string }, string>;

function makeRunner(options: {
  name: RunnerName;
  priority?: number;
  available?: boolean;
  availabilityError?: Error;
  result?: string;
  invokeError?: Error;
}): TestRunner {
  const runner: TestRunner = {
    name: options.name,
    isAvailable: vi.fn(async () => {
      if (options.availabilityError !== undefined) {
        throw options.availabilityError;
      }

      return options.available ?? true;
    }),
    invoke: vi.fn(async () => {
      if (options.invokeError !== undefined) {
        throw options.invokeError;
      }

      return options.result ?? `${options.name}-plan`;
    }),
  };

  if (options.priority !== undefined) {
    runner.priority = options.priority;
  }

  return runner;
}

describe('RunnerChain', () => {
  it('Given all runners available, when plan is requested, then Claude runner is selected', async () => {
    const codex = makeRunner({ name: 'codex' });
    const gemini = makeRunner({ name: 'gemini' });
    const claude = makeRunner({ name: 'claude' });
    const chain = new RunnerChain([codex, gemini, claude]);

    await expect(chain.plan('plan this', { ticket: 'PAN-7790' })).resolves.toBe('claude-plan');

    expect(claude.invoke).toHaveBeenCalledOnce();
    expect(codex.invoke).not.toHaveBeenCalled();
    expect(gemini.invoke).not.toHaveBeenCalled();
  });

  it('Given Claude returns RunnerUnavailableError, when plan is requested, then Codex runner is attempted', async () => {
    const fallbackEvents: RunnerFallbackEvent[] = [];
    const claude = makeRunner({
      name: 'claude',
      invokeError: new RunnerUnavailableError('Claude API unavailable', {
        runner: 'claude',
      }),
    });
    const codex = makeRunner({ name: 'codex', result: 'codex-result' });
    const gemini = makeRunner({ name: 'gemini' });
    const chain = new RunnerChain([claude, codex, gemini], {
      onFallback: (event) => {
        fallbackEvents.push(event);
      },
    });

    await expect(chain.plan('plan this', { ticket: 'PAN-7790' })).resolves.toBe('codex-result');

    expect(claude.invoke).toHaveBeenCalledOnce();
    expect(codex.invoke).toHaveBeenCalledOnce();
    expect(gemini.invoke).not.toHaveBeenCalled();
    expect(fallbackEvents).toEqual([
      {
        runner: 'claude',
        phase: 'invoke',
        reason: 'Claude API unavailable',
        next_runner: 'codex',
        code: 'runner_unavailable',
      },
    ]);
  });

  it('Given Claude availability check returns RunnerUnavailableError, when plan is requested, then Codex runner is attempted', async () => {
    const fallbackEvents: RunnerFallbackEvent[] = [];
    const claude = makeRunner({
      name: 'claude',
      availabilityError: new RunnerUnavailableError('Claude health check failed', {
        runner: 'claude',
      }),
    });
    const codex = makeRunner({ name: 'codex', result: 'codex-result' });
    const chain = new RunnerChain([claude, codex], {
      onFallback: (event) => {
        fallbackEvents.push(event);
      },
    });

    await expect(chain.plan('plan this', { ticket: 'PAN-7790' })).resolves.toBe('codex-result');

    expect(claude.invoke).not.toHaveBeenCalled();
    expect(codex.invoke).toHaveBeenCalledOnce();
    expect(fallbackEvents).toEqual([
      {
        runner: 'claude',
        phase: 'availability',
        reason: 'Claude health check failed',
        next_runner: 'codex',
        code: 'runner_unavailable',
      },
    ]);
  });

  it('Given Claude and Codex unavailable, when plan is requested, then Gemini runner is attempted', async () => {
    const claude = makeRunner({ name: 'claude', available: false });
    const codex = makeRunner({ name: 'codex', available: false });
    const gemini = makeRunner({ name: 'gemini', result: 'gemini-result' });
    const chain = new RunnerChain([claude, codex, gemini]);

    await expect(chain.plan('plan this', { ticket: 'PAN-7790' })).resolves.toBe('gemini-result');

    expect(claude.invoke).not.toHaveBeenCalled();
    expect(codex.invoke).not.toHaveBeenCalled();
    expect(gemini.invoke).toHaveBeenCalledOnce();
  });

  it('Given all runners unavailable, when plan is requested, then fail-fast with structured error', async () => {
    const chain = new RunnerChain([
      makeRunner({ name: 'claude', available: false }),
      makeRunner({ name: 'codex', available: false }),
      makeRunner({ name: 'gemini', available: false }),
    ]);

    try {
      await chain.plan('plan this', { ticket: 'PAN-7790' });
      throw new Error('Expected RunnerChain.plan to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AllRunnersUnavailableError);
      expect((error as AllRunnersUnavailableError).toJSON()).toEqual({
        code: 'all_runners_unavailable',
        message: 'All planning runners are unavailable',
        failures: [
          {
            runner: 'claude',
            phase: 'availability',
            reason: 'isAvailable returned false',
            code: 'runner_unavailable',
          },
          {
            runner: 'codex',
            phase: 'availability',
            reason: 'isAvailable returned false',
            code: 'runner_unavailable',
          },
          {
            runner: 'gemini',
            phase: 'availability',
            reason: 'isAvailable returned false',
            code: 'runner_unavailable',
          },
        ],
      });
    }
  });

  it('Given a runner succeeds, when plan completes, then no further runners are attempted', async () => {
    const claude = makeRunner({ name: 'claude', result: 'claude-result' });
    const codex = makeRunner({ name: 'codex' });
    const chain = new RunnerChain([claude, codex]);

    await expect(chain.plan('plan this', { ticket: 'PAN-7790' })).resolves.toBe('claude-result');

    expect(claude.isAvailable).toHaveBeenCalledOnce();
    expect(claude.invoke).toHaveBeenCalledOnce();
    expect(codex.isAvailable).not.toHaveBeenCalled();
    expect(codex.invoke).not.toHaveBeenCalled();
  });

  it('Given fallback occurs, when plan completes, then fallback event is logged with reason and next_runner', async () => {
    const fallbackEvents: RunnerFallbackEvent[] = [];
    const chain = new RunnerChain(
      [
        makeRunner({ name: 'claude', available: false }),
        makeRunner({ name: 'codex', result: 'codex-result' }),
      ],
      {
        onFallback: (event) => {
          fallbackEvents.push(event);
        },
      },
    );

    await expect(chain.plan('plan this', { ticket: 'PAN-7790' })).resolves.toBe('codex-result');

    expect(fallbackEvents).toEqual([
      {
        runner: 'claude',
        phase: 'availability',
        reason: 'isAvailable returned false',
        next_runner: 'codex',
        code: 'runner_unavailable',
      },
    ]);
  });

  it('Given runner priority is overridden in config, when chain orders runners, then custom priority is used', async () => {
    const claude = makeRunner({ name: 'claude' });
    const codex = makeRunner({ name: 'codex', result: 'codex-result' });
    const chain = new RunnerChain([claude, codex], {
      runnerPriorities: {
        claude: 50,
        codex: 5,
      },
    });

    await expect(chain.plan('plan this', { ticket: 'PAN-7793' })).resolves.toBe('codex-result');

    expect(codex.invoke).toHaveBeenCalledOnce();
    expect(claude.invoke).not.toHaveBeenCalled();
  });

  it('Given fallback is disabled in config, when Claude fails, then fail-fast instead of trying fallback', async () => {
    const fallbackEvents: RunnerFallbackEvent[] = [];
    const claude = makeRunner({
      name: 'claude',
      invokeError: new RunnerUnavailableError('Claude API unavailable', {
        runner: 'claude',
      }),
    });
    const codex = makeRunner({ name: 'codex', result: 'codex-result' });
    const chain = new RunnerChain([claude, codex], {
      fallbackEnabled: false,
      onFallback: (event) => {
        fallbackEvents.push(event);
      },
    });

    await expect(chain.plan('plan this', { ticket: 'PAN-7793' })).rejects.toMatchObject({
      name: 'RunnerUnavailableError',
      message: 'Claude API unavailable',
      runner: 'claude',
    });

    expect(claude.invoke).toHaveBeenCalledOnce();
    expect(codex.invoke).not.toHaveBeenCalled();
    expect(fallbackEvents).toEqual([
      {
        runner: 'claude',
        phase: 'invoke',
        reason: 'Claude API unavailable',
        next_runner: null,
        code: 'runner_unavailable',
      },
    ]);
  });
});
