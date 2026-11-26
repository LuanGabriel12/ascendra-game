export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogContext {
  readonly event_id?: string | undefined;
  readonly correlation_id?: string | undefined;
  readonly aggregate_id?: string | undefined;
  readonly operation?: string | undefined;
  readonly result?: string | undefined;
  readonly reason?: string | undefined;
  readonly settlement_version?: number | undefined;
  readonly [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const SENSITIVE_KEY_PATTERN = /(password|secret|token|authorization|cookie|credential|connectionstring|database_url)/i;

function sanitizeFields(fields: LogContext): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export class StructuredLogger implements Logger {
  private readonly minPriority: number;
  private readonly sink: (jsonLine: string) => void;

  constructor(
    level: LogLevel = "info",
    sink: (jsonLine: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {
    this.minPriority = LEVEL_PRIORITY[level];
    this.sink = sink;
  }

  public debug(message: string, context: LogContext = {}): void {
    this.emit("debug", message, context);
  }

  public info(message: string, context: LogContext = {}): void {
    this.emit("info", message, context);
  }

  public warn(message: string, context: LogContext = {}): void {
    this.emit("warn", message, context);
  }

  public error(message: string, context: LogContext = {}): void {
    this.emit("error", message, context);
  }

  private emit(level: Exclude<LogLevel, "silent">, message: string, context: LogContext): void {
    if (LEVEL_PRIORITY[level] < this.minPriority) {
      return;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: "carbon",
      message,
      ...sanitizeFields(context),
    };
    this.sink(JSON.stringify(entry));
  }
}
