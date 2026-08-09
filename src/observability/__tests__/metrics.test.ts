import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryRunnerMetrics, recordRunnerMetric } from '../metrics.js';

describe('metrics', () => {
  let dir: string;
  let eventsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-metrics-'));
    eventsPath = path.join(dir, 'runner-invocations.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Given no events file exists, when metrics are queried, then an empty summary is returned', async () => {
    const summary = await queryRunnerMetrics({ eventsPath });

    expect(summary).toEqual({
      totalAttempts: 0,
      totalFallbacks: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      fallbackRate: 0,
      runnerDistribution: {},
    });
  });

  it('Given planning completes, when metrics are queried, then fallback rate and runner distribution are available', async () => {
    const timestamp = '2026-08-09T00:00:00.000Z';

    await recordRunnerMetric(
      { event: 'runner_attempt', runner: 'claude', timestamp },
      { eventsPath },
    );
    await recordRunnerMetric(
      { event: 'runner_failure', runner: 'claude', timestamp, reason: 'boom' },
      { eventsPath },
    );
    await recordRunnerMetric(
      { event: 'fallback_triggered', runner: 'claude', next_runner: 'codex', timestamp },
      { eventsPath },
    );
    await recordRunnerMetric(
      { event: 'runner_attempt', runner: 'codex', timestamp },
      { eventsPath },
    );
    await recordRunnerMetric(
      { event: 'runner_success', runner: 'codex', latencyMs: 42, timestamp },
      { eventsPath },
    );

    const summary = await queryRunnerMetrics({ eventsPath });

    expect(summary).toEqual({
      totalAttempts: 2,
      totalFallbacks: 1,
      totalSuccesses: 1,
      totalFailures: 1,
      fallbackRate: 0.5,
      runnerDistribution: { claude: 1, codex: 1 },
    });
  });
});
