export function startKuma(url: string, healthy: () => boolean, signal: AbortSignal): () => void {
    let running = false;
    const timer = setInterval(() => {
        if (running || signal.aborted || !healthy()) return;
        running = true;
        void (async () => {
            try {
                const response = await fetch(url, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
                });
                await response.body?.cancel();
            } catch {
                // Heartbeats are deliberately silent, including during an outage.
            } finally {
                running = false;
            }
        })();
    }, 60_000);
    const stop = () => {
        clearInterval(timer);
        signal.removeEventListener("abort", stop);
    };
    signal.addEventListener("abort", stop, { once: true });
    return stop;
}
