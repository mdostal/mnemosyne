import type { PlanResponse } from '../types/PlanResponse.js';

export interface RunnerInvocationContext {
  metricName?: string;
  metadata?: Record<string, unknown>;
}

export abstract class RunnerStrategy {
  abstract readonly name: string;
  abstract readonly priority: number;

  abstract isAvailable(): Promise<boolean>;

  abstract invoke(prompt: string, context?: RunnerInvocationContext): Promise<PlanResponse>;
}

export class RunnerUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'RunnerUnavailableError';
    this.cause = options?.cause;
  }
}
