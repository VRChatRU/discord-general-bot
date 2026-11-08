import { describe, expect, spyOn, test } from "bun:test";
import {
    GuildScheduledEventEntityType,
    GuildScheduledEventStatus,
    type GuildScheduledEvent,
    type User,
} from "discord.js";
import { createEventsPlugin, renderEvents } from "../plugins/events.ts";
import { Store } from "../src/store.ts";
import type { PluginContext } from "../src/types.ts";

const now = Date.UTC(2026, 10, 8, 12);
const location = "https://vrc.group/EXAMPLE.0000";

type EventFields = Pick<
    GuildScheduledEvent,
    | "id"
    | "name"
    | "description"
    | "scheduledStartTimestamp"
    | "scheduledEndTimestamp"
    | "status"
    | "entityType"
    | "entityMetadata"
    | "creator"
>;

function event(overrides: Partial<EventFields> = {}): GuildScheduledEvent {
    return {
        id: "100",
        name: "Community meetup",
        description: "First paragraph\n\nSecond paragraph",
        scheduledStartTimestamp: now + 3_600_000,
        scheduledEndTimestamp: now + 7_200_000,
        status: GuildScheduledEventStatus.Scheduled,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location },
        creator: { globalName: "Organizer", username: "organizer" } as User,
        ...overrides,
    } as GuildScheduledEvent;
}

describe("event export", () => {
    test("keeps the VRChat JSON contract and UTC weekday", () => {
        expect(renderEvents([event()], location, now)).toEqual([
            {
                name: "Community meetup",
                desc: "First paragraph",
                time: (now + 3_600_000) / 1_000,
                end: (now + 7_200_000) / 1_000,
                day: 0,
                by: "Organizer",
            },
        ]);
    });

    test("selects upcoming external events and ongoing events only at the configured location", () => {
        const items = [
            event({
                id: "active",
                status: GuildScheduledEventStatus.Active,
                scheduledStartTimestamp: now - 3_600_000,
            }),
            event({ id: "future" }),
            event({ id: "wrong-location", entityMetadata: { location: "elsewhere" } }),
            event({ id: "voice", entityType: GuildScheduledEventEntityType.Voice }),
            event({ id: "completed", status: GuildScheduledEventStatus.Completed }),
            event({ id: "canceled", status: GuildScheduledEventStatus.Canceled }),
            event({ id: "stale", scheduledStartTimestamp: now - 1 }),
            event({ id: "distant", scheduledStartTimestamp: now + 7 * 86_400_000 + 1 }),
            event({ id: "unknown", scheduledStartTimestamp: null }),
            event({ id: "missing-location", entityMetadata: null }),
        ];

        const result = renderEvents(items, location, now);
        expect(result).toHaveLength(2);
        expect(result[0]!.time).toBe((now - 3_600_000) / 1_000);
        expect(result[1]!.time).toBe((now + 3_600_000) / 1_000);
    });

    test("handles missing optional Discord fields and invalid ending times", () => {
        const result = renderEvents(
            [
                event({ id: "1", creator: null, description: null, scheduledEndTimestamp: null }),
                event({
                    id: "2",
                    creator: { globalName: null, username: "fallback" } as User,
                    scheduledEndTimestamp: now,
                }),
            ],
            location,
            now,
        );

        expect(result[0]!.desc).toBe("");
        expect(result[0]!.by).toBe("");
        expect(result[0]!.end).toBe(result[0]!.time);
        expect(result[1]!.by).toBe("fallback");
        expect(result[1]!.end).toBe(result[1]!.time);
    });

    test("renders deterministic ordering and handles Windows paragraph separators", () => {
        const items = [
            event({ id: "2", name: "Second" }),
            event({ id: "1", name: "First", description: "Intro\r\n \r\nDetails" }),
        ];

        expect(renderEvents(items, location, now).map((item) => item.name)).toEqual(["First", "Second"]);
        expect(renderEvents(items, location, now)[0]!.desc).toBe("Intro");
        expect(renderEvents([], location, now)).toEqual([]);
    });

    test("retries an unchanged failed Gist update and caches only successful publication", async () => {
        const store = new Store(":memory:");
        const controller = new AbortController();
        const requests: unknown[] = [];
        const fakeFetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)));
            return new Response("{}", { status: requests.length === 1 ? 503 : 200 });
        }) as typeof fetch;
        const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
        const item = event({ scheduledStartTimestamp: Date.now() + 60_000 });
        const ctx = {
            client: {
                isReady: () => true,
                guilds: {
                    fetch: async () => ({
                        scheduledEvents: { fetch: async () => new Map([[item.id, item]]) },
                    }),
                },
            },
            config: {
                serverId: "123",
                userAgent: "test",
                gistId: "abc",
                eventsLocation: location,
                githubToken: "test",
            },
            log: { info() {}, warn() {}, error() {} },
            store,
            signal: controller.signal,
        } as unknown as PluginContext;
        let run!: () => Promise<void>;
        const plugin = createEventsPlugin(ctx, (_ctx, _name, task) => {
            run = task;
            return () => {};
        });

        try {
            await plugin.start?.();
            await expect(run()).rejects.toThrow("HTTP 503");
            expect(store.getState(`events:last-published:abc:${location}`)).toBeNull();

            await run();
            expect(requests).toHaveLength(2);
            expect(requests[1]).toEqual(requests[0]);
            expect(store.getState(`events:last-published:abc:${location}`)).not.toBeNull();

            await run();
            expect(requests).toHaveLength(2);
        } finally {
            controller.abort();
            await plugin.stop?.();
            fetchMock.mockRestore();
            store.close();
        }
    });

    test("publishes an empty initial schedule to clear stale remote events", async () => {
        const store = new Store(":memory:");
        const controller = new AbortController();
        const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
        const ctx = {
            client: {
                isReady: () => true,
                guilds: { fetch: async () => ({ scheduledEvents: { fetch: async () => new Map() } }) },
            },
            config: {
                serverId: "123",
                userAgent: "test",
                gistId: "abc",
                eventsLocation: location,
                githubToken: "test",
            },
            log: { info() {}, warn() {}, error() {} },
            store,
            signal: controller.signal,
        } as unknown as PluginContext;
        let run!: () => Promise<void>;
        const plugin = createEventsPlugin(ctx, (_ctx, _name, task) => {
            run = task;
            return () => {};
        });

        try {
            await plugin.start?.();
            await run();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
                files: { "vrcruEvents.json": { content: "[]" } },
            });
            expect(store.getState(`events:last-published:abc:${location}`)).toBe("[]");
        } finally {
            controller.abort();
            await plugin.stop?.();
            fetchMock.mockRestore();
            store.close();
        }
    });
});
