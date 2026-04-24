export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogMetadata = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
}

function formatMetadata(metadata?: LogMetadata): string {
  if (!metadata || Object.keys(metadata).length === 0) return "";
  return ` ${JSON.stringify(metadata)}`;
}

export function logEvent(level: LogLevel, scope: string, message: string, metadata?: LogMetadata): void {
  const timestamp = new Date().toISOString();
  const formatted = `[${level}] ${timestamp} [${scope}] ${message}${formatMetadata(metadata)}`;

  if (level === "error") {
    console.error(formatted);
    return;
  }

  if (level === "warn") {
    console.warn(formatted);
    return;
  }

  console.log(formatted);
}

export function createRunLogger(scope: string, runId: string): Logger {
  const baseScope = `${scope}:${runId}`;

  return {
    debug(message, metadata) {
      logEvent("debug", baseScope, message, metadata);
    },
    info(message, metadata) {
      logEvent("info", baseScope, message, metadata);
    },
    warn(message, metadata) {
      logEvent("warn", baseScope, message, metadata);
    },
    error(message, metadata) {
      logEvent("error", baseScope, message, metadata);
    },
  };
}
