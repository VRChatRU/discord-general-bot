import { ActivityType, Events } from "discord.js";
import { fetchJson } from "../src/http.ts";
import { startPeriodicTask } from "../src/tasks.ts";
import type { Plugin, PluginContext } from "../src/types.ts";

const stateKey = "player-count:last-successful";

export function parsePlayerCount(value: unknown): number {
    const count =
        typeof value === "number"
            ? value
            : typeof value === "string" && /^\d+$/.test(value)
              ? Number(value)
              : NaN;

    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("VRChat returned an invalid player count");
    }
    return count;
}

export function createPlayerCountPlugin(ctx: PluginContext, schedule = startPeriodicTask): Plugin {
    let stop: (() => void) | undefined;
    let lastCount: number | undefined;
    let lastAppliedCount: number | undefined;

    const applyPresence = () => {
        if (!ctx.client.isReady() || lastCount === undefined) return;
        ctx.client.user.setPresence({
            activities: [{ name: `VRChat с ${lastCount} пользователями`, type: ActivityType.Playing }],
        });
        lastAppliedCount = lastCount;
    };

    const restorePresence = () => {
        try {
            applyPresence();
        } catch (error) {
            lastAppliedCount = undefined;
            ctx.log.warn("Could not restore player-count presence", { error });
        }
    };

    const resetPresence = () => {
        lastAppliedCount = undefined;
    };

    return {
        name: "player-count",
        start() {
            const cached = ctx.store.getState(stateKey);
            if (cached !== null) {
                try {
                    lastCount = parsePlayerCount(cached);
                } catch {
                    ctx.log.warn("Ignoring an invalid cached player count");
                }
            }

            restorePresence();
            ctx.client.on(Events.ShardResume, restorePresence);
            ctx.client.on(Events.ClientReady, restorePresence);
            ctx.client.on(Events.ShardDisconnect, resetPresence);
            stop = schedule(ctx, "Player count", async () => {
                if (!ctx.client.isReady()) return;
                const response = await fetchJson<unknown>(
                    "https://api.vrchat.cloud/api/1/visits",
                    {
                        headers: { "User-Agent": ctx.config.userAgent },
                    },
                    ctx.signal,
                );
                ctx.signal.throwIfAborted();
                const count = parsePlayerCount(response);

                if (count !== lastCount) {
                    ctx.store.setState(stateKey, String(count));
                    lastCount = count;
                }

                if (count !== lastAppliedCount) applyPresence();
            });
        },
        stop() {
            stop?.();
            ctx.client.off(Events.ShardResume, restorePresence);
            ctx.client.off(Events.ClientReady, restorePresence);
            ctx.client.off(Events.ShardDisconnect, resetPresence);
        },
    };
}
