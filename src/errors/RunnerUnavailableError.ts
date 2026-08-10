export interface RunnerUnavailableOptions {
  runner?: string;
  code?: string;
  cause?: unknown;
}

export interface RunnerFailure {
  runner: string;
  phase: 'availability' | 'invoke';
  reason: string;
  code?: string;
}

export class RunnerUnavailableError extends Error {
  readonly code: string;
  readonly runner?: string;

  constructor(message = 'Runner unavailable', options: RunnerUnavailableOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RunnerUnavailableError';
    this.code = options.code ?? 'runner_unavailable';

    if (options.runner !== undefined) {
      this.runner = options.runner;
    }
  }
}

export class AllRunnersUnavailableError extends Error {
  readonly code = 'all_runners_unavailable';
  readonly failures: readonly RunnerFailure[];

  constructor(failures: readonly RunnerFailure[]) {
    super('All planning runners are unavailable');
    this.name = 'AllRunnersUnavailableError';
    this.failures = failures;
  }

  toJSON(): {
    code: string;
    message: string;
    failures: readonly RunnerFailure[];
  } {
    return {
      code: this.code,
      message: this.message,
      failures: this.failures,
    };
  }
}
