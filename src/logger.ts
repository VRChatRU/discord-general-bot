import { closeSync, openSync } from "node:fs";

export class Logger {
    private readonly sink: ReturnType<Bun.BunFile["writer"]>;
    private readonly fd: number;
    private failed = false;
    private closed = false;

    constructor(
        path: string,
        private readonly secrets: string[] = [],
    ) {
        // Bun's path writer starts at offset zero; an append descriptor preserves previous runs.
        this.fd = openSync(path, "a", 0o600);
        try {
            this.sink = Bun.file(this.fd).writer({ highWaterMark: 1 });
        } catch (error) {
            closeSync(this.fd);
            throw error;
        }
    }

    private write(level: string, message: string, data?: Record<string, unknown>) {
        try {
            const seen = new WeakSet<object>();
            let line = JSON.stringify(
                { time: new Date().toISOString(), level, message, ...data },
                (_key, value: unknown) => {
                    if (value instanceof Error) {
                        const detail = value as Error & { code?: unknown; status?: unknown };
                        return {
                            name: detail.name,
                            message: detail.message,
                            code: detail.code,
                            status: detail.status,
                        };
                    }
                    if (typeof value === "bigint") return String(value);
                    if (value && typeof value === "object") {
                        if (seen.has(value)) return "[Circular]";
                        seen.add(value);
                    }
                    return value;
                },
            );
            for (const secret of this.secrets) {
                if (secret) line = line.split(secret).join("[REDACTED]");
            }
            console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](line);
            this.sink.write(`${line}\n`);
            const flushed = this.sink.flush();
            if (flushed instanceof Promise) void flushed.catch(() => this.reportFailure());
        } catch {
            this.reportFailure();
        }
    }

    private reportFailure() {
        if (!this.failed) console.error("Could not write application log");
        this.failed = true;
    }

    info(message: string, data?: Record<string, unknown>) {
        this.write("info", message, data);
    }
    warn(message: string, data?: Record<string, unknown>) {
        this.write("warn", message, data);
    }
    error(message: string, data?: Record<string, unknown>) {
        this.write("error", message, data);
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.sink.end();
        } catch {
            this.reportFailure();
        } finally {
            try {
                closeSync(this.fd);
            } catch {
                this.reportFailure();
            }
        }
    }
}
