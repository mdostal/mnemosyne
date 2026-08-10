import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Given info is logged, when the record is written, then it is JSON with level and event', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('runner_attempt', { runner: 'claude' });

    expect(spy).toHaveBeenCalledOnce();
    const record = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ level: 'info', event: 'runner_attempt', runner: 'claude' });
    expect(typeof record.timestamp).toBe('string');
  });

  it('Given warn is logged, when the record is written, then console.warn receives it', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    logger.warn('fallback_triggered', { runner: 'claude', next_runner: 'codex' });

    expect(spy).toHaveBeenCalledOnce();
    const record = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ level: 'warn', event: 'fallback_triggered' });
  });

  it('Given error is logged, when the record is written, then console.error receives it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.error('runner_failure', { runner: 'claude', reason: 'boom' });

    expect(spy).toHaveBeenCalledOnce();
    const record = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ level: 'error', event: 'runner_failure', reason: 'boom' });
  });
});
