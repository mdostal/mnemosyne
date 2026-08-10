import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getMetricSamples,
  metrics,
  queryRunnerMetrics,
  recordRunnerMetric,
  resetMetricSamples,
} from '../metrics.js';

describe('metrics', () => {
  let dir: string;
  let eventsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-metrics-'));
    eventsPath = path.join(dir, 'runner-invocations.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    resetMetricSamples();
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

  it('Given recall instrumentation records samples, when metrics are read, then histogram and counter samples are available', () => {
    metrics.histogram('recall_duration_ms', 12, { scope: 'project', ok: true });
    metrics.counter('layer_degraded_total', 1, { layer: 'vector', scope: 'project' });

    expect(getMetricSamples()).toEqual([
      expect.objectContaining({
        type: 'histogram',
        name: 'recall_duration_ms',
        value: 12,
        fields: { scope: 'project', ok: true },
        timestamp: expect.any(String),
      }),
      expect.objectContaining({
        type: 'counter',
        name: 'layer_degraded_total',
        value: 1,
        fields: { layer: 'vector', scope: 'project' },
        timestamp: expect.any(String),
      }),
    ]);
  });
});
