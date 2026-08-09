import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type MetricFields = Record<string, unknown>;

export interface Metrics {
  histogram(name: string, value: number, fields?: MetricFields): void;
  counter(name: string, value?: number, fields?: MetricFields): void;
}

export interface MetricSample {
  type: 'histogram' | 'counter';
  name: string;
  value: number;
  timestamp: string;
  fields: MetricFields;
}

const metricSamples: MetricSample[] = [];

export const metrics: Metrics = {
  histogram: (name, value, fields) => recordMetricSample('histogram', name, value, fields),
  counter: (name, value = 1, fields) => recordMetricSample('counter', name, value, fields),
};

export const DEFAULT_METRICS_EVENTS_PATH = path.join(
  '.pHive',
  'metrics',
  'events',
  'runner-invocations.jsonl',
);

export type RunnerMetricEventType =
  | 'runner_attempt'
  | 'fallback_triggered'
  | 'runner_success'
  | 'runner_failure';

export interface RunnerMetricEvent {
  event: RunnerMetricEventType;
  runner: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface RunnerMetricsOptions {
  eventsPath?: string;
  cwd?: string;
}

export async function recordRunnerMetric(
  event: RunnerMetricEvent,
  options: RunnerMetricsOptions = {},
): Promise<void> {
  const filePath = resolveEventsPath(options.eventsPath, options.cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

export interface RunnerMetricsSummary {
  totalAttempts: number;
  totalFallbacks: number;
  totalSuccesses: number;
  totalFailures: number;
  fallbackRate: number;
  runnerDistribution: Record<string, number>;
}

export async function queryRunnerMetrics(
  options: RunnerMetricsOptions = {},
): Promise<RunnerMetricsSummary> {
  const filePath = resolveEventsPath(options.eventsPath, options.cwd);
  const events = await readMetricEvents(filePath);

  const summary: RunnerMetricsSummary = {
    totalAttempts: 0,
    totalFallbacks: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    fallbackRate: 0,
    runnerDistribution: {},
  };

  for (const event of events) {
    switch (event.event) {
      case 'runner_attempt':
        summary.totalAttempts += 1;
        summary.runnerDistribution[event.runner] =
          (summary.runnerDistribution[event.runner] ?? 0) + 1;
        break;
      case 'fallback_triggered':
        summary.totalFallbacks += 1;
        break;
      case 'runner_success':
        summary.totalSuccesses += 1;
        break;
      case 'runner_failure':
        summary.totalFailures += 1;
        break;
      default:
        break;
    }
  }

  summary.fallbackRate = summary.totalAttempts > 0 ? summary.totalFallbacks / summary.totalAttempts : 0;

  return summary;
}

export function getMetricSamples(): MetricSample[] {
  return metricSamples.map((sample) => ({
    ...sample,
    fields: { ...sample.fields },
  }));
}

export function resetMetricSamples(): void {
  metricSamples.splice(0, metricSamples.length);
}

function recordMetricSample(
  type: MetricSample['type'],
  name: string,
  value: number,
  fields: MetricFields = {},
): void {
  metricSamples.push({
    type,
    name,
    value,
    timestamp: new Date().toISOString(),
    fields: { ...fields },
  });
}

async function readMetricEvents(filePath: string): Promise<RunnerMetricEvent[]> {
  let raw: string;

  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunnerMetricEvent);
}

function resolveEventsPath(eventsPath: string | undefined, cwd = process.cwd()): string {
  const requested = eventsPath ?? DEFAULT_METRICS_EVENTS_PATH;
  return path.isAbsolute(requested) ? requested : path.join(cwd, requested);
}

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
