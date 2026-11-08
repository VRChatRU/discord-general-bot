import {
    GuildScheduledEventEntityType,
    GuildScheduledEventStatus,
    type GuildScheduledEvent,
} from "discord.js";
import { fetchJson } from "../src/http.ts";
import { startPeriodicTask } from "../src/tasks.ts";
import type { Plugin, PluginContext } from "../src/types.ts";

type ScheduledEvent = Pick<
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

export interface PublishedEvent {
    name: string;
    desc: string;
    time: number;
    end: number;
    day: number;
    by: string;
}

export function renderEvents(
    events: Iterable<ScheduledEvent>,
    location: string,
    now = Date.now(),
): PublishedEvent[] {
    const weekAhead = now + 7 * 24 * 60 * 60 * 1_000;

    return Array.from(events)
        .filter((event) => {
            const start = event.scheduledStartTimestamp;
            return (
                event.entityType === GuildScheduledEventEntityType.External &&
                event.entityMetadata?.location === location &&
                (event.status === GuildScheduledEventStatus.Scheduled ||
                    event.status === GuildScheduledEventStatus.Active) &&
                start !== null &&
                Number.isFinite(start) &&
                start <= weekAhead &&
                (start >= now || event.status === GuildScheduledEventStatus.Active)
            );
        })
        .sort(
            (left, right) =>
                left.scheduledStartTimestamp! - right.scheduledStartTimestamp! ||
                left.id.localeCompare(right.id),
        )
        .map((event) => {
            const start = event.scheduledStartTimestamp!;
            const end = event.scheduledEndTimestamp;

            return {
                name: event.name,
                desc: event.description?.split(/\r?\n\s*\r?\n/, 1)[0] ?? "",
                time: Math.floor(start / 1_000),
                end: Math.floor(Math.max(start, end !== null && Number.isFinite(end) ? end : start) / 1_000),
                day: new Date(start).getUTCDay(),
                by: event.creator?.globalName ?? event.creator?.username ?? "",
            };
        });
}

export function createEventsPlugin(ctx: PluginContext, schedule = startPeriodicTask): Plugin {
    let stop: (() => void) | undefined;

    return {
        name: "events",
        start() {
            const { eventsLocation, gistId, githubToken, serverId, userAgent } = ctx.config;
            if (!eventsLocation || !gistId || !githubToken) {
                ctx.log.info("Event publishing is disabled");
                return;
            }

            const stateKey = `events:last-published:${gistId}:${eventsLocation}`;
            stop = schedule(ctx, "Event publishing", async () => {
                if (!ctx.client.isReady()) return;
                const guild = await ctx.client.guilds.fetch(serverId);
                const events = await guild.scheduledEvents.fetch();
                const rendered = renderEvents(events.values(), eventsLocation);
                const content = JSON.stringify(rendered, null, 2);

                if (ctx.store.getState(stateKey) === content) return;

                await fetchJson<unknown>(
                    `https://api.github.com/gists/${encodeURIComponent(gistId)}`,
                    {
                        method: "PATCH",
                        headers: {
                            "User-Agent": userAgent,
                            Accept: "application/vnd.github+json",
                            "Content-Type": "application/json",
                            "X-GitHub-Api-Version": "2026-03-10",
                            Authorization: `Bearer ${githubToken.replace(/^(?:Bearer|token)\s+/i, "")}`,
                        },
                        body: JSON.stringify({ files: { "vrcruEvents.json": { content } } }),
                    },
                    ctx.signal,
                );

                ctx.signal.throwIfAborted();
                ctx.store.setState(stateKey, content);
                ctx.log.info("Published Discord events", { count: rendered.length });
            });
        },
        stop() {
            stop?.();
        },
    };
}
