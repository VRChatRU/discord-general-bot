export async function fetchJson<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    }
    return (await response.json()) as T;
}
