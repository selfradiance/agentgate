export function generateRequestId(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export function createLogger(requestId?: string) {
  function log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (requestId) {
      entry["requestId"] = requestId;
    }
    if (extra) {
      Object.assign(entry, extra);
    }
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  return {
    info:  (message: string, extra?: Record<string, unknown>) => log("info",  message, extra),
    warn:  (message: string, extra?: Record<string, unknown>) => log("warn",  message, extra),
    error: (message: string, extra?: Record<string, unknown>) => log("error", message, extra),
  };
}
