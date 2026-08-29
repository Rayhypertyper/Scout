export type LogLevel = "debug" | "info" | "warn" | "error";

const ranks: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  public constructor(private readonly minimum: LogLevel = "info") {}

  public debug(tag: string, message: string): void {
    this.write("debug", tag, message);
  }

  public info(tag: string, message: string): void {
    this.write("info", tag, message);
  }

  public warn(tag: string, message: string): void {
    this.write("warn", tag, message);
  }

  public error(tag: string, message: string): void {
    this.write("error", tag, message);
  }

  private write(level: LogLevel, tag: string, message: string): void {
    if (ranks[level] < ranks[this.minimum]) return;
    const line = `[${tag.toLocaleUpperCase()}] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
