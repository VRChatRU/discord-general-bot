import { describe, expect, mock, test } from "bun:test";
import { PermissionFlagsBits, type Message } from "discord.js";
import { createAuditPlugin } from "../plugins/audit.ts";
import { EMBED_COLOR } from "../src/style.ts";
import type { PluginContext } from "../src/types.ts";

function fixtures() {
    const controller = new AbortController();
    const rows = [{ id: "queued-event", payload: JSON.stringify({ content: "Кто: <@123>\nКуда: <#456>" }) }];
    const thread = {
        id: "thread",
        guildId: "guild",
        archived: false,
        locked: false,
        isThread: () => true,
        permissionsFor: mock(() => ({ has: (_permissions: unknown): boolean => true })),
        send: mock(async (_options: unknown) => ({ id: "log-message" })),
    };
    const store = {
        pendingAudit: mock((limit: number) => rows.slice(0, limit)),
        removeAudit: mock((id: string) => {
            const index = rows.findIndex((row) => row.id === id);
            if (index !== -1) rows.splice(index, 1);
        }),
    };
    const dm = mock((_message: Message) => {});
    const ctx = {
        client: { isReady: () => true, user: { id: "bot" }, channels: { fetch: mock(async () => thread) } },
        config: { auditThreadId: "thread", serverId: "guild", weeklyImageHostId: "host" },
        signal: controller.signal,
        store,
        log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
        audit: { dm },
    } as unknown as PluginContext;
    let run!: () => Promise<void>;
    const stop = mock(() => {});
    const plugin = createAuditPlugin(ctx, (_ctx, _name, task, options) => {
        run = task;
        expect(options?.intervalMs).toBe(15_000);
        return stop;
    });
    const incoming = (authorId = "person", attachments = 0) =>
        ({
            guildId: null,
            author: { id: authorId, bot: false },
            content: "Hello",
            attachments: { size: attachments },
        }) as Message;
    return { controller, rows, thread, store, dm, ctx, plugin, run: () => run(), stop, incoming };
}

describe("audit thread delivery", () => {
    test("delivers minimal embeds with the shared sticky color and no pings", async () => {
        const { plugin, run, thread, rows } = fixtures();
        rows[0]!.payload = JSON.stringify({
            embeds: [
                {
                    title: "Сообщение отправлено",
                    description: "<@123> → <#456>\n\nТекст",
                    color: 0,
                    url: "https://discord.com/channels/1/2/3",
                    timestamp: "2026-11-08",
                    fields: [{ name: "Unexpected", value: "Ignored" }],
                    image: { url: "https://outside.test" },
                },
            ],
            allowedMentions: { parse: ["users", "everyone"] },
            channelId: "other-channel",
        });
        await plugin.start?.();
        await run();
        expect(thread.send).toHaveBeenCalledWith({
            embeds: [
                {
                    title: "Сообщение отправлено",
                    description: "<@123> → <#456>\n\nТекст",
                    color: EMBED_COLOR,
                    url: "https://discord.com/channels/1/2/3",
                    timestamp: "2026-11-08T00:00:00.000Z",
                },
            ],
            allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
            nonce: "queued-event",
            enforceNonce: true,
        });
        expect(rows).toHaveLength(0);
    });

    test("missing embed permission retains an embed while legacy text logs remain deliverable", async () => {
        const { plugin, run, thread, rows } = fixtures();
        thread.permissionsFor.mockReturnValue({
            has: (permissions) => permissions !== PermissionFlagsBits.EmbedLinks,
        });
        const legacy = rows[0]!.payload;
        rows[0]!.payload = JSON.stringify({
            embeds: [{ title: "Сообщение изменено", description: "<@123> → <#456>" }],
        });
        await plugin.start?.();
        await expect(run()).rejects.toThrow("Embed Links");
        expect(rows).toHaveLength(1);
        expect(thread.send).not.toHaveBeenCalled();
        rows[0]!.payload = legacy;
        await run();
        expect(rows).toHaveLength(0);
    });

    test("invalid embed data is retained for retry and cannot be sent", async () => {
        const valid = { title: "Log", description: "Body" };
        for (const embeds of [
            [],
            [valid, valid],
            [{ ...valid, title: "x".repeat(257) }],
            [{ ...valid, description: "x".repeat(4_097) }],
            [{ ...valid, url: "https://outside.test/message" }],
            [{ ...valid, timestamp: "not-a-date" }],
        ]) {
            const { plugin, run, thread, rows } = fixtures();
            rows[0]!.payload = JSON.stringify({ embeds });
            await plugin.start?.();
            await expect(run()).rejects.toThrow();
            expect(rows).toHaveLength(1);
            expect(thread.send).not.toHaveBeenCalled();
        }
    });

    test("delivers only to the configured thread and always disables every mention type", async () => {
        const { plugin, run, thread, store, rows } = fixtures();
        rows[0]!.payload = JSON.stringify({
            content: "Кто: <@123>\nКуда: <#456>",
            channelId: "other-channel",
            allowedMentions: { parse: ["everyone"] },
        });
        await plugin.start?.();
        await run();
        expect(thread.send).toHaveBeenCalledWith({
            content: "Кто: <@123>\nКуда: <#456>",
            allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
            nonce: "queued-event",
            enforceNonce: true,
        });
        expect(store.removeAudit).toHaveBeenCalledWith("queued-event");
        expect(rows).toHaveLength(0);
    });

    test("failed sends keep the persistent row and reuse its nonce on retry", async () => {
        const { plugin, run, thread, rows } = fixtures();
        thread.send.mockRejectedValueOnce(new Error("Offline"));
        await plugin.start?.();
        await expect(run()).rejects.toThrow("Offline");
        expect(rows).toHaveLength(1);
        await run();
        expect(thread.send).toHaveBeenCalledTimes(2);
        expect(thread.send.mock.calls[0]![0]).toEqual(thread.send.mock.calls[1]![0]);
        expect(rows).toHaveLength(0);
    });

    test("a failed later row preserves that row and does not resend acknowledged earlier rows", async () => {
        const { plugin, run, thread, rows } = fixtures();
        rows.push({ id: "second-event", payload: JSON.stringify({ content: "Second event" }) });
        thread.send.mockResolvedValueOnce({ id: "first" }).mockRejectedValueOnce(new Error("Offline"));
        await plugin.start?.();
        await expect(run()).rejects.toThrow("Offline");
        expect(rows.map((row) => row.id)).toEqual(["second-event"]);
        await run();
        expect(thread.send).toHaveBeenCalledTimes(3);
        expect(rows).toHaveLength(0);
    });

    test("delivery is single-flight even when triggered twice", async () => {
        const { plugin, run, thread } = fixtures();
        const barrier = Promise.withResolvers<void>();
        thread.send.mockImplementationOnce(async () => {
            await barrier.promise;
            return { id: "sent" };
        });
        await plugin.start?.();
        const first = run();
        await Promise.resolve();
        const second = run();
        await Promise.resolve();
        expect(thread.send).toHaveBeenCalledTimes(1);
        barrier.resolve();
        await Promise.all([first, second]);
        expect(thread.send).toHaveBeenCalledTimes(1);
    });

    test("rejects a non-thread or another server without dropping the row", async () => {
        for (const wrong of ["type", "guild"]) {
            const { plugin, run, thread, rows } = fixtures();
            if (wrong === "type") thread.isThread = () => false;
            else thread.guildId = "other-guild";
            await plugin.start?.();
            await expect(run()).rejects.toThrow("configured server");
            expect(thread.send).not.toHaveBeenCalled();
            expect(rows).toHaveLength(1);
        }
    });

    test("missing thread permissions and an archived locked thread are retryable", async () => {
        const { plugin, run, thread, rows } = fixtures();
        thread.permissionsFor.mockReturnValue({ has: () => false });
        await plugin.start?.();
        await expect(run()).rejects.toThrow("Send Messages in Threads");
        expect(thread.send).not.toHaveBeenCalled();
        thread.permissionsFor.mockReturnValue({ has: () => true });
        thread.archived = thread.locked = true;
        await expect(run()).rejects.toThrow("archived and locked");
        expect(rows).toHaveLength(1);
        expect(thread.permissionsFor).toHaveBeenCalled();
        expect(PermissionFlagsBits.SendMessagesInThreads).toBeGreaterThan(0n);
    });

    test("does not fetch a thread while idle or disconnected", async () => {
        const { plugin, run, rows, ctx } = fixtures();
        await plugin.start?.();
        rows.length = 0;
        await run();
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
        rows.push({ id: "queued-event", payload: JSON.stringify({ content: "Still queued" }) });
        ctx.client.isReady = (() => false) as typeof ctx.client.isReady;
        await run();
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
        expect(rows).toHaveLength(1);
    });

    test("disabled logging does not schedule delivery or record DMs", async () => {
        const { ctx, incoming, dm } = fixtures();
        ctx.config.auditThreadId = undefined;
        const schedule = mock(() => () => {});
        const plugin = createAuditPlugin(ctx, schedule);
        await plugin.start?.();
        await plugin.onMessage?.(incoming());
        expect(schedule).not.toHaveBeenCalled();
        expect(dm).not.toHaveBeenCalled();
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
    });

    test("stopping clears the scheduled task and cancellation prevents any sends", async () => {
        const { plugin, run, stop, controller, thread, rows } = fixtures();
        await plugin.start?.();
        await plugin.stop?.();
        expect(stop).toHaveBeenCalledTimes(1);
        controller.abort();
        await run();
        expect(thread.send).not.toHaveBeenCalled();
        expect(rows).toHaveLength(1);
    });

    test("a successful acknowledgement is removed even if cancellation arrived during send", async () => {
        const { plugin, run, controller, thread, rows } = fixtures();
        thread.send.mockImplementationOnce(async () => {
            controller.abort();
            return { id: "sent" };
        });
        await plugin.start?.();
        await run();
        expect(rows).toHaveLength(0);
    });

    test("invalid queued payloads cannot send a ping or discard the row", async () => {
        const { plugin, run, rows, thread } = fixtures();
        rows[0]!.payload = JSON.stringify({
            content: "x".repeat(2_001),
            allowedMentions: { parse: ["everyone"] },
        });
        await plugin.start?.();
        await expect(run()).rejects.toThrow("Invalid queued audit message");
        expect(thread.send).not.toHaveBeenCalled();
        expect(rows).toHaveLength(1);
    });

    test("reads a bounded batch of at most ten rows", async () => {
        const { plugin, run, rows, store, thread } = fixtures();
        for (let i = 1; i < 12; i++)
            rows.push({ id: `event-${i}`, payload: JSON.stringify({ content: `Event ${i}` }) });
        await plugin.start?.();
        await run();
        expect(store.pendingAudit).toHaveBeenCalledWith(10);
        expect(thread.send).toHaveBeenCalledTimes(10);
        expect(rows).toHaveLength(2);
    });
});

describe("incoming DM audit", () => {
    test("records ordinary human DMs including attachments", async () => {
        const { plugin, incoming, dm } = fixtures();
        for (const message of [incoming(), incoming("person", 2)]) {
            await plugin.onMessage?.(message);
            expect(dm).toHaveBeenLastCalledWith(message);
        }
        expect(dm).toHaveBeenCalledTimes(2);
    });

    test("ignores banner submissions but records text-only DMs from the same authorized person", async () => {
        const { plugin, incoming, dm } = fixtures();
        await plugin.onMessage?.(incoming("host", 1));
        expect(dm).not.toHaveBeenCalled();
        const text = incoming("host");
        await plugin.onMessage?.(text);
        expect(dm).toHaveBeenCalledWith(text);
    });

    test("ignores bots, guild messages and cancellation without creating audit loops", async () => {
        const { plugin, incoming, dm, controller } = fixtures();
        const bot = incoming();
        Object.assign(bot.author, { bot: true });
        const guild = incoming();
        Object.assign(guild, { guildId: "guild" });
        await plugin.onMessage?.(bot);
        await plugin.onMessage?.(guild);
        controller.abort();
        await plugin.onMessage?.(incoming());
        expect(dm).not.toHaveBeenCalled();
    });
});
