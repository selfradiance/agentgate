export function generateRequestId(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export function createLogger(requestId?: string) {
  function log(level: "info" | "warn" | "error", message: string) {
    const entry: Record<string, string> = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (requestId) {
      entry["requestId"] = requestId;
    }
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  return {
    info:  (message: string) => log("info",  message),
    warn:  (message: string) => log("warn",  message),
    error: (message: string) => log("error", message),
  };
}
