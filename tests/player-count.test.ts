import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ActivityType, Events } from "discord.js";
import { createPlayerCountPlugin, parsePlayerCount } from "../plugins/player-count.ts";
import { Store } from "../src/store.ts";
import type { PluginContext } from "../src/types.ts";

describe("VRChat player count", () => {
    test("accepts valid numeric responses, including zero", () => {
        expect(parsePlayerCount(123_456)).toBe(123_456);
        expect(parsePlayerCount("123456")).toBe(123_456);
        expect(parsePlayerCount(0)).toBe(0);
        expect(parsePlayerCount("0")).toBe(0);
    });

    test("rejects malformed responses without treating them as a zero count", () => {
        for (const response of [
            null,
            undefined,
            false,
            "",
            " ",
            {},
            [],
            "-1",
            -1,
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => parsePlayerCount(response)).toThrow("invalid player count");
        }
    });

    test("restores cached presence after a new gateway session and avoids redundant polls", async () => {
        const store = new Store(":memory:");
        store.setState("player-count:last-successful", "42");
        const controller = new AbortController();
        const setPresence = mock(() => {});
        const client = Object.assign(new EventEmitter(), {
            isReady: () => true,
            user: { setPresence },
        });
        let count = 42;
        const fakeFetch = Object.assign(async () => Response.json(count), { preconnect: fetch.preconnect });
        const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
        const info = mock(() => {});
        const ctx = {
            client,
            config: { userAgent: "test" },
            log: { info, warn() {}, error() {} },
            store,
            signal: controller.signal,
        } as unknown as PluginContext;
        let run!: () => Promise<void>;
        const plugin = createPlayerCountPlugin(ctx, (_ctx, _name, task) => {
            run = task;
            return () => {};
        });

        try {
            await plugin.start?.();
            expect(setPresence).toHaveBeenCalledTimes(1);

            client.emit(Events.ClientReady);
            expect(setPresence).toHaveBeenCalledTimes(2);

            await run();
            expect(setPresence).toHaveBeenCalledTimes(2);

            client.emit(Events.ShardDisconnect);
            await run();
            expect(setPresence).toHaveBeenCalledTimes(3);

            client.emit(Events.ShardResume);
            expect(setPresence).toHaveBeenCalledTimes(4);

            count = 43;
            await run();
            expect(store.getState("player-count:last-successful")).toBe("43");
            expect(setPresence).toHaveBeenLastCalledWith({
                activities: [{ name: "VRChat с 43 пользователями", type: ActivityType.Playing }],
            });
            expect(setPresence).toHaveBeenCalledTimes(5);
            expect(info).not.toHaveBeenCalled();

            await plugin.stop?.();
            client.emit(Events.ClientReady);
            expect(setPresence).toHaveBeenCalledTimes(5);
        } finally {
            controller.abort();
            await plugin.stop?.();
            fetchMock.mockRestore();
            store.close();
        }
    });
});
