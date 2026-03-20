type LogData = Record<string, unknown> | string;

function formatLog(level: string, data: LogData, msg?: string, bindings?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = { level, time: Date.now() };
  if (bindings) Object.assign(entry, bindings);
  if (typeof data === 'string') {
    entry.msg = data;
  } else {
    Object.assign(entry, data);
    if (msg) entry.msg = msg;
  }
  return JSON.stringify(entry);
}

function createLogger(bindings?: Record<string, unknown>) {
  return {
    info(data: LogData, msg?: string) {
      console.log(formatLog('info', data, msg, bindings));
    },
    warn(data: LogData, msg?: string) {
      console.warn(formatLog('warn', data, msg, bindings));
    },
    error(data: LogData, msg?: string) {
      console.error(formatLog('error', data, msg, bindings));
    },
    debug(data: LogData, msg?: string) {
      console.log(formatLog('debug', data, msg, bindings));
    },
    fatal(data: LogData, msg?: string) {
      console.error(formatLog('fatal', data, msg, bindings));
    },
  };
}

export const logger = createLogger();

export function childLogger(bindings: Record<string, unknown>) {
  return createLogger(bindings);
}
