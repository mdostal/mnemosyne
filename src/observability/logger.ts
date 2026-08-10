export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface StructuredLogRecord {
  level: LogLevel;
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const record: StructuredLogRecord = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(record);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger: Logger = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};
