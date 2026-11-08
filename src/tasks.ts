import type { PluginContext } from "./types.ts";

export function startPeriodicTask(
    ctx: PluginContext,
    name: string,
    task: () => Promise<void>,
    { intervalMs = 60_000, immediate = true }: { intervalMs?: number; immediate?: boolean } = {},
): () => void {
    let running = false;
    let stopped = false;
    let failed = false;
    const run = () => {
        if (running || stopped || ctx.signal.aborted) return;
        running = true;
        const pending = (async () => {
            try {
                await task();
                if (failed && !ctx.signal.aborted) ctx.log.info(`${name} recovered`);
                failed = false;
            } catch (error) {
                if (!failed && !ctx.signal.aborted) ctx.log.warn(`${name} failed; will retry`, { error });
                failed = true;
            } finally {
                running = false;
            }
        })();
        ctx.pending?.add(pending);
        void pending.finally(() => ctx.pending?.delete(pending));
    };
    const timer = setInterval(run, intervalMs);
    const stop = () => {
        stopped = true;
        clearInterval(timer);
        ctx.signal.removeEventListener("abort", stop);
    };
    ctx.signal.addEventListener("abort", stop, { once: true });
    if (immediate) run();
    return stop;
}
