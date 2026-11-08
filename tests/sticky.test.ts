import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChannelType, type EmbedBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import { createStickyPlugin } from "../plugins/sticky.ts";
import { Store } from "../src/store.ts";
import type { PluginContext } from "../src/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const stop of cleanup.splice(0)) stop();
});

async function eventually(check: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await Bun.sleep(5);
    }
    throw new Error("Condition did not become true");
}

type StickyPayload = { embeds: EmbedBuilder[] };

function acknowledge(id: string, options: StickyPayload) {
    return {
        id,
        embeds: options.embeds.map((embed) => {
            const data = embed.toJSON();
            return {
                ...data,
                footer: data.footer ? { text: data.footer.text, iconURL: data.footer.icon_url } : null,
            };
        }),
        edit: mock(async (_options: StickyPayload) => {}),
    };
}

function fixtures() {
    const controller = new AbortController();
    const store = new Store(":memory:");
    let sequence = 0;
    const operations: string[] = [];
    const channel = {
        id: "channel",
        guildId: "guild",
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
        messages: {
            delete: mock(async (id: string) => {
                operations.push(`delete:${id}`);
            }),
        },
        send: mock(async (options: StickyPayload) => {
            operations.push(`send:${options.embeds[0]?.data.description}`);
            return acknowledge(`new-${++sequence}`, options);
        }),
    };
    const log = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
    const ctx = {
        client: { channels: { fetch: mock(async () => channel) }, isReady: () => true },
        config: { serverId: "guild", stickyHeader: "Header", stickyFooter: "Footer" },
        store,
        log,
        signal: controller.signal,
        pending: new Set<Promise<unknown>>(),
    } as unknown as PluginContext;
    let plugin = createStickyPlugin(ctx, { delayMs: 15, repairIntervalMs: 15 });
    cleanup.push(() => {
        controller.abort();
        void plugin.stop?.();
        store.close();
    });
    const interaction = (command: string, text = "Updated", channelId = "channel") =>
        ({
            commandName: command,
            user: { id: "moderator" },
            options: { getChannel: () => ({ id: channelId }), getString: () => text },
            editReply: mock(async () => {}),
        }) as unknown as ChatInputCommandInteraction<"cached">;
    const execute = (command: string, text?: string, channelId?: string) => {
        return plugin
            .commands!.find((item) => item.data.name === command)!
            .execute(interaction(command, text, channelId));
    };
    const message = (channelId = "channel") =>
        ({ guildId: "guild", channelId, author: { bot: false }, system: false }) as Message;
    const restart = () => {
        void plugin.stop?.();
        plugin = createStickyPlugin(ctx, { delayMs: 15, repairIntervalMs: 15 });
        return plugin;
    };
    return { controller, store, channel, log, operations, ctx, plugin, execute, message, restart };
}

describe("sticky recovery", () => {
    test("an already deleted old message is replaced without an escaping error", async () => {
        const { store, channel, execute } = fixtures();
        store.setSticky("channel", "Old");
        store.setStickyMessage("channel", "old-message");
        channel.messages.delete.mockRejectedValue({ code: 10008 });
        await execute("stick");
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(store.getSticky("channel")?.messageId).toBe("new-1");
        expect(store.getSticky("channel")?.dirty).toBe(0);
    });

    test("a permission failure keeps the old ID, avoids duplicates, and repairs after recovery", async () => {
        const { store, channel, execute, plugin, log } = fixtures();
        store.setSticky("channel", "Old");
        store.setStickyMessage("channel", "old-message");
        channel.messages.delete.mockRejectedValue({ code: 50013 });
        await execute("stick");
        await execute("stick", "Latest");
        expect(store.getSticky("channel")?.messageId).toBe("old-message");
        expect(channel.send).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledTimes(1);
        channel.messages.delete.mockResolvedValue(undefined);
        await plugin.start?.();
        await eventually(() => store.getSticky("channel")?.messageId === "new-1");
        expect(store.getSticky("channel")?.content).toBe("Latest");
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test("a failed send remains pending and reuses its nonce after plugin restart", async () => {
        const { store, channel, execute, restart } = fixtures();
        channel.send.mockRejectedValueOnce(new Error("Network unavailable"));
        await execute("stick");
        const first = store.getSticky("channel")!;
        expect(first.messageId).toBeNull();
        expect(first.dirty).toBe(1);
        await restart().start?.();
        await eventually(() => store.getSticky("channel")?.messageId === "new-1");
        expect(channel.send.mock.calls[0]?.[0]).toMatchObject({ nonce: first.nonce, enforceNonce: true });
        expect(channel.send.mock.calls[1]?.[0]).toMatchObject({ nonce: first.nonce, enforceNonce: true });
    });

    test("an unchanged acknowledged embed does not need an edit", async () => {
        const { channel, execute } = fixtures();
        let sent!: ReturnType<typeof acknowledge>;
        channel.send.mockImplementationOnce(async (options) => {
            sent = acknowledge("accepted", options);
            return sent;
        });
        await execute("stick");
        expect(sent.edit).not.toHaveBeenCalled();
    });

    test("a repeated nonce updates an earlier accepted message to the latest text", async () => {
        const { store, channel, execute } = fixtures();
        let accepted!: ReturnType<typeof acknowledge>;
        channel.send.mockImplementationOnce(async (options) => {
            accepted = acknowledge("accepted", options);
            throw new Error("Response lost after Discord accepted the message");
        });
        await execute("stick", "First");
        const nonce = store.getSticky("channel")!.nonce;
        channel.send.mockResolvedValueOnce(accepted);
        await execute("stick", "Latest");
        expect(channel.send.mock.calls[1]?.[0]).toMatchObject({ nonce, enforceNonce: true });
        expect(accepted.edit).toHaveBeenCalledTimes(1);
        expect(accepted.edit.mock.calls[0]?.[0].embeds[0]?.data.description).toBe("Latest");
        expect(store.getSticky("channel")).toMatchObject({
            content: "Latest",
            messageId: "accepted",
            dirty: 0,
        });
        expect(channel.messages.delete).not.toHaveBeenCalled();
    });

    test("a failed nonce reconciliation keeps the acknowledged ID for repair", async () => {
        const { store, channel, execute, plugin, operations } = fixtures();
        let accepted!: ReturnType<typeof acknowledge>;
        channel.send.mockImplementationOnce(async (options) => {
            accepted = acknowledge("accepted", options);
            throw new Error("Response lost after Discord accepted the message");
        });
        await execute("stick", "First");
        accepted.edit.mockRejectedValueOnce(new Error("Network unavailable"));
        channel.send.mockResolvedValueOnce(accepted);
        await execute("stick", "Latest");
        expect(store.getSticky("channel")).toMatchObject({
            content: "Latest",
            messageId: "accepted",
            dirty: 1,
        });
        await plugin.start?.();
        await eventually(() => store.getSticky("channel")?.messageId === "new-1");
        expect(operations).toEqual(["delete:accepted", "send:Latest"]);
    });

    test("an acknowledged ID is persisted when shutdown starts during a send", async () => {
        const { controller, store, channel, execute, log } = fixtures();
        let release!: () => void;
        channel.send.mockImplementationOnce(async (options) => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return acknowledge("accepted", options);
        });
        const sending = execute("stick");
        await eventually(() => Boolean(release));
        controller.abort();
        release();
        await sending;
        expect(store.getSticky("channel")).toMatchObject({ messageId: "accepted", dirty: 1 });
        expect(log.warn).not.toHaveBeenCalled();
    });

    test("failed removal is persisted and retried without recreating the message", async () => {
        const { store, channel, execute, plugin } = fixtures();
        store.setSticky("channel", "Old");
        store.setStickyMessage("channel", "old-message");
        channel.messages.delete.mockRejectedValueOnce(new Error("Network unavailable"));
        await execute("delstick");
        expect(store.getSticky("channel")?.retiring).toBe(1);
        await plugin.start?.();
        await eventually(() => store.getSticky("channel") === null);
        expect(channel.send).not.toHaveBeenCalled();
    });
});

describe("sticky channel concurrency", () => {
    test("simultaneous updates in one channel execute sequentially", async () => {
        const { store, channel, execute, operations } = fixtures();
        store.setSticky("channel", "Old");
        store.setStickyMessage("channel", "old-message");
        let release!: () => void;
        channel.messages.delete.mockImplementationOnce(async (id: string) => {
            operations.push(`delete:${id}`);
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        });
        const first = execute("stick", "First");
        const second = execute("stick", "Second");
        await eventually(() => Boolean(release));
        expect(channel.send).not.toHaveBeenCalled();
        release();
        await Promise.all([first, second]);
        expect(operations).toEqual(["delete:old-message", "send:First", "delete:new-1", "send:Second"]);
        expect(store.getSticky("channel")?.content).toBe("Second");
        expect(store.getSticky("channel")?.messageId).toBe("new-2");
    });

    test("a blocked channel does not block another channel", async () => {
        const { channel, execute, ctx } = fixtures();
        let release!: () => void;
        channel.send.mockImplementationOnce(async (options) => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return acknowledge("first", options);
        });
        const first = execute("stick", "First", "a");
        await eventually(() => Boolean(release));
        await execute("stick", "Second", "b");
        expect(ctx.store.getSticky("b")?.messageId).toBe("new-1");
        release();
        await first;
        expect(ctx.store.getSticky("a")?.messageId).toBe("first");
    });

    test("delete cancels a pending activity timer and cannot resurrect the sticky", async () => {
        const { store, channel, execute, plugin, message } = fixtures();
        store.setSticky("channel", "Old");
        store.setStickyMessage("channel", "old-message");
        await plugin.onMessage?.(message());
        await execute("delstick");
        await Bun.sleep(35);
        expect(store.getSticky("channel")).toBeNull();
        expect(channel.send).not.toHaveBeenCalled();
    });

    test("new activity during a send remains dirty for a subsequent refresh", async () => {
        const { store, channel, execute, plugin, message } = fixtures();
        let release!: () => void;
        channel.send.mockImplementationOnce(async (options) => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return acknowledge("first", options);
        });
        const initial = execute("stick");
        await eventually(() => Boolean(release));
        await plugin.onMessage?.(message());
        release();
        await initial;
        await eventually(() => channel.send.mock.calls.length === 2);
        expect(store.getSticky("channel")?.dirty).toBe(0);
    });

    test("oversized combined embed is rejected before saving or posting", async () => {
        const { ctx, execute, channel, store } = fixtures();
        ctx.config.stickyHeader = "H".repeat(256);
        ctx.config.stickyFooter = "F".repeat(2048);
        await expect(execute("stick", "T".repeat(4000))).rejects.toThrow("6000");
        expect(store.getSticky("channel")).toBeNull();
        expect(channel.send).not.toHaveBeenCalled();
    });
});
