import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ChannelType, PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { createSayPlugin, parseMessageReference } from "../plugins/say.ts";
import { UserError } from "../src/discord.ts";
import { downloadMedia, MAX_MEDIA_BYTES, mediaLimit, uploadLimit } from "../src/media.ts";
import type { PluginContext } from "../src/types.ts";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const otherChannelId = "333333333333333333";
const dmId = "444444444444444444";
const messageId = "555555555555555555";
const botId = "666666666666666666";
const bytes = Buffer.from("video-bytes");
const attachment = {
    name: "clip.mp4",
    url: "https://cdn.discordapp.com/ephemeral-attachments/123/456/clip.mp4?ex=123&hm=456",
    size: bytes.length,
};
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
});

function fixtures() {
    const result = {
        id: messageId,
        url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
        content: undefined as string | undefined,
        attachments: undefined as Map<string, { name: string; url: string }> | undefined,
    };
    const original = {
        ...result,
        author: { id: botId },
        content: "Original text",
        attachments: new Map([
            ["old-media", { name: "old.mp4", url: "https://cdn.discordapp.com/attachments/old.mp4" }],
        ]),
        edit: mock(async (_options: unknown) => result),
    };
    const channel = {
        id: channelId,
        type: ChannelType.GuildText,
        guildId,
        guild: { premiumTier: 0 },
        permissionsFor: mock(() => ({ has: (_permission: unknown): boolean => true })),
        send: mock(async (_options: unknown) => result),
        messages: { fetch: mock(async (_id: string) => original) },
    };
    const dm = {
        id: dmId,
        type: ChannelType.DM,
        recipient: { id: "777777777777777777" },
        send: mock(async (_options: unknown) => result),
        messages: { fetch: mock(async (_id: string) => original) },
    };
    const recipient = { id: "777777777777777777", createDM: mock(async () => dm) };
    const options = {
        user: null as typeof recipient | null,
        channel: null as { id: string } | null,
        messageId: null as string | null,
        message: "@everyone announcement" as string | null,
        media: null as typeof attachment | null,
    };
    const fetchChannel = mock(async (_id: string): Promise<typeof channel | typeof dm> => channel);
    const audit = { message: mock((_event: unknown) => {}) };
    const ctx = {
        client: { user: { id: botId }, channels: { fetch: fetchChannel } },
        config: { serverId: guildId },
        signal: new AbortController().signal,
        log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
        audit,
    } as unknown as PluginContext;
    const interaction = {
        id: "interaction",
        user: { id: "moderator" },
        channelId,
        attachmentSizeLimit: 20 * 1_024 * 1_024,
        options: {
            getUser: () => options.user,
            getChannel: () => options.channel,
            getString: (name: string) => (name === "message-id" ? options.messageId : options.message),
            getAttachment: () => options.media,
        },
        editReply: mock(async (_content: unknown) => {}),
    };
    const command = createSayPlugin(ctx).commands![0]!;
    const execute = () => command.execute(interaction as unknown as ChatInputCommandInteraction<"cached">);
    return {
        channel,
        dm,
        original,
        result,
        recipient,
        options,
        ctx,
        audit,
        fetchChannel,
        interaction,
        command,
        execute,
    };
}

describe("say targets and edits", () => {
    test("has moderator defaults and optional target, message and media fields", () => {
        const { command } = fixtures();
        expect(command.data.default_member_permissions).toBe(String(PermissionFlagsBits.ManageMessages));
        expect(command.data.options?.map((option) => option.name)).toEqual([
            "user",
            "channel",
            "message-id",
            "message",
            "media",
        ]);
        expect(command.data.options?.some((option) => "required" in option && option.required)).toBe(false);
    });

    test("sends to the current channel with mentions disabled and a deduplication nonce", async () => {
        const { channel, ctx, execute, interaction } = fixtures();
        await execute();
        expect(ctx.client.channels.fetch).toHaveBeenCalledWith(channelId);
        expect(channel.send).toHaveBeenCalledWith({
            content: "@everyone announcement",
            allowedMentions: { parse: [] },
            nonce: "interaction",
            enforceNonce: true,
        });
        expect(interaction.editReply).toHaveBeenCalledTimes(1);
    });

    test("sends only to the explicitly selected user DM", async () => {
        const { channel, dm, ctx, options, recipient, execute } = fixtures();
        options.user = recipient;
        await execute();
        expect(recipient.createDM).toHaveBeenCalledTimes(1);
        expect(dm.send).toHaveBeenCalledTimes(1);
        expect(channel.send).not.toHaveBeenCalled();
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
    });

    test("rejects ambiguous user and channel targets before any network action", async () => {
        const { ctx, options, recipient, execute } = fixtures();
        options.user = recipient;
        options.channel = { id: channelId };
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(recipient.createDM).not.toHaveBeenCalled();
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
    });

    test("uses the selected channel for a raw message ID and keeps existing attachments on a text edit", async () => {
        const { channel, original, options, execute } = fixtures();
        options.channel = { id: channelId };
        options.messageId = messageId;
        await execute();
        expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
        expect(original.edit).toHaveBeenCalledWith({
            content: "@everyone announcement",
            allowedMentions: { parse: [] },
        });
        expect(channel.send).not.toHaveBeenCalled();
    });

    test("derives a message link's channel without using the current channel", async () => {
        const { channel, ctx, original, options, execute } = fixtures();
        channel.id = otherChannelId;
        options.messageId = `https://discord.com/channels/${guildId}/${otherChannelId}/${messageId}`;
        await execute();
        expect(ctx.client.channels.fetch).toHaveBeenCalledWith(otherChannelId);
        expect(original.edit).toHaveBeenCalledTimes(1);
    });

    test("rejects cross-guild links and links contradicting the selected channel", async () => {
        const { ctx, options, execute } = fixtures();
        options.messageId = `https://discord.com/channels/999999999999999999/${channelId}/${messageId}`;
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        options.messageId = `https://discord.com/channels/${guildId}/${otherChannelId}/${messageId}`;
        options.channel = { id: channelId };
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
    });

    test("a DM link must match an explicitly selected user's DM", async () => {
        const { dm, original, options, recipient, execute } = fixtures();
        options.messageId = `https://discord.com/channels/@me/${otherChannelId}/${messageId}`;
        options.user = recipient;
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(dm.messages.fetch).not.toHaveBeenCalled();
        options.messageId = `https://discord.com/channels/@me/${dmId}/${messageId}`;
        await execute();
        expect(dm.messages.fetch).toHaveBeenCalledWith(messageId);
        expect(original.edit).toHaveBeenCalledTimes(1);
    });

    test("a link alone can edit the bot's own DM message", async () => {
        const { dm, original, options, fetchChannel, execute } = fixtures();
        options.messageId = `https://discord.com/channels/@me/${dmId}/${messageId}`;
        fetchChannel.mockResolvedValue(dm);
        await execute();
        expect(fetchChannel).toHaveBeenCalledWith(dmId);
        expect(dm.messages.fetch).toHaveBeenCalledWith(messageId);
        expect(original.edit).toHaveBeenCalledTimes(1);
    });

    test("a link marked as a DM cannot edit a guild channel or contradict a selected guild channel", async () => {
        const { original, options, execute } = fixtures();
        options.messageId = `https://discord.com/channels/@me/${channelId}/${messageId}`;
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        options.channel = { id: channelId };
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("refuses to edit someone else's message before downloading media", async () => {
        const { original, options, execute } = fixtures();
        original.author.id = "someone-else";
        options.messageId = messageId;
        options.media = attachment;
        fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected download"));
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(original.edit).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("reports unknown messages and closed DMs with safe user errors", async () => {
        const { channel, options, recipient, execute } = fixtures();
        options.messageId = messageId;
        channel.messages.fetch.mockRejectedValue(
            Object.assign(new Error("Unknown Message"), { code: 10008 }),
        );
        await expect(execute()).rejects.toThrow("Сообщение не найдено");
        options.messageId = null;
        options.user = recipient;
        recipient.createDM.mockRejectedValue(
            Object.assign(new Error("Cannot send messages"), { code: 50007 }),
        );
        await expect(execute()).rejects.toThrow("Не удалось отправить ЛС");
    });

    test("does not post without channel permissions or into another server", async () => {
        const { channel, execute } = fixtures();
        channel.permissionsFor.mockReturnValue({ has: () => false });
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        channel.permissionsFor.mockReturnValue({ has: () => true });
        channel.guildId = "other-guild";
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(channel.send).not.toHaveBeenCalled();
    });

    test("requires history permission for edits and attachment permission for media", async () => {
        const { channel, original, options, execute } = fixtures();
        options.messageId = messageId;
        channel.permissionsFor.mockReturnValue({
            has: (permission) => permission !== PermissionFlagsBits.ReadMessageHistory,
        });
        await expect(execute()).rejects.toThrow("историю");
        options.messageId = null;
        options.media = attachment;
        channel.permissionsFor.mockReturnValue({
            has: (permission) => permission !== PermissionFlagsBits.AttachFiles,
        });
        await expect(execute()).rejects.toThrow("Прикреплять файлы");
        expect(original.edit).not.toHaveBeenCalled();
        expect(channel.send).not.toHaveBeenCalled();
    });

    test("rejects empty content without media before fetching a channel", async () => {
        const { channel, ctx, execute, options } = fixtures();
        options.message = "  \n ";
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
        expect(channel.send).not.toHaveBeenCalled();
    });

    test("an explicitly blank message ID cannot accidentally send a new message", async () => {
        const { channel, ctx, execute, options } = fixtures();
        options.messageId = "  \n ";
        await expect(execute()).rejects.toBeInstanceOf(UserError);
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
        expect(channel.send).not.toHaveBeenCalled();
    });

    test("does not blindly retry a failed send or report success", async () => {
        const { channel, execute, interaction } = fixtures();
        channel.send.mockRejectedValue(new Error("Connection lost after sending"));
        await expect(execute()).rejects.toThrow("Connection lost");
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(interaction.editReply).not.toHaveBeenCalled();
    });

    test("accepts a media-only video message", async () => {
        const { channel, execute, options } = fixtures();
        options.message = null;
        options.media = attachment;
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
        await execute();
        expect(channel.send.mock.calls[0]?.[0]).toEqual({
            files: [{ attachment: bytes, name: "clip.mp4" }],
            allowedMentions: { parse: [] },
            nonce: "interaction",
            enforceNonce: true,
        });
    });

    test("new media replaces previous attachments while preserving omitted text", async () => {
        const { original, options, execute } = fixtures();
        options.message = null;
        options.messageId = messageId;
        options.media = attachment;
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
        await execute();
        expect(original.edit).toHaveBeenCalledWith({
            files: [{ attachment: bytes, name: "clip.mp4" }],
            attachments: [],
            allowedMentions: { parse: [] },
        });
    });

    test("serializes media memory use without blocking text-only operations", async () => {
        const { channel, options, execute } = fixtures();
        const response = Promise.withResolvers<Response>();
        fetchSpy = spyOn(globalThis, "fetch").mockReturnValue(response.promise);
        options.media = attachment;
        const pending = execute();
        await expect(execute()).rejects.toThrow("обрабатывает медиа");
        options.media = null;
        await execute();
        response.resolve(new Response(bytes));
        await pending;
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenCalledTimes(2);
    });

    test("a failed media download releases the busy slot for the next command", async () => {
        const { channel, options, execute } = fixtures();
        options.media = attachment;
        fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
        await expect(execute()).rejects.toThrow("Offline");
        expect(channel.send).not.toHaveBeenCalled();
        fetchSpy.mockResolvedValue(new Response(bytes));
        await execute();
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test("rejects media beyond the bot's destination limit even for a Nitro-sized interaction", async () => {
        const { options, recipient, interaction, execute, dm } = fixtures();
        options.user = recipient;
        options.media = { ...attachment, size: 21 * 1_024 * 1_024 };
        interaction.attachmentSizeLimit = 100 * 1_024 * 1_024;
        fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected download"));
        await expect(execute()).rejects.toThrow("20 МиБ");
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(dm.send).not.toHaveBeenCalled();
    });
});

describe("say audit records", () => {
    test("records who sent a channel message, its destination, text and returned media", async () => {
        const { audit, result, execute } = fixtures();
        result.content = "Actual Discord content";
        result.attachments = new Map([
            ["new", { name: "clip.mp4", url: "https://cdn.discordapp.com/attachments/new.mp4" }],
        ]);
        await execute();
        expect(audit.message).toHaveBeenCalledWith({
            action: "sent",
            actorId: "moderator",
            channelId,
            messageId,
            recipientId: undefined,
            content: "Actual Discord content",
            previousContent: undefined,
            attachments: [{ name: "clip.mp4", url: "https://cdn.discordapp.com/attachments/new.mp4" }],
            source: "say",
        });
    });

    test("records the recipient for explicit DMs and link-only DM edits", async () => {
        const { audit, dm, options, recipient, fetchChannel, execute } = fixtures();
        options.user = recipient;
        await execute();
        expect(audit.message.mock.calls[0]?.[0]).toMatchObject({
            channelId: dmId,
            recipientId: recipient.id,
            action: "sent",
        });
        options.user = null;
        options.messageId = `https://discord.com/channels/@me/${dmId}/${messageId}`;
        fetchChannel.mockResolvedValue(dm);
        await execute();
        expect(audit.message.mock.calls[1]?.[0]).toMatchObject({
            channelId: dmId,
            recipientId: recipient.id,
            action: "edited",
        });
    });

    test("captures old text before edit mutates the original cached message", async () => {
        const { original, result, options, audit, execute } = fixtures();
        options.messageId = messageId;
        result.content = "Updated text from Discord";
        original.edit.mockImplementation(async () => {
            original.content = "Cache already mutated";
            return result;
        });
        await execute();
        expect(audit.message.mock.calls[0]?.[0]).toMatchObject({
            action: "edited",
            previousContent: "Original text",
            content: "Updated text from Discord",
        });
    });

    test("a media-only edit audits the preserved original text", async () => {
        const { options, audit, execute } = fixtures();
        options.message = null;
        options.messageId = messageId;
        options.media = attachment;
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
        await execute();
        expect(audit.message.mock.calls[0]?.[0]).toMatchObject({
            content: "Original text",
            previousContent: "Original text",
        });
    });

    test("failed sends produce no success audit, but a failed reply cannot erase a successful send audit", async () => {
        const { channel, result, interaction, audit, execute } = fixtures();
        channel.send.mockRejectedValue(new Error("Send failed"));
        await expect(execute()).rejects.toThrow("Send failed");
        expect(audit.message).not.toHaveBeenCalled();
        channel.send.mockResolvedValue(result);
        interaction.editReply.mockImplementation(async () => {
            expect(audit.message).toHaveBeenCalledTimes(1);
            throw new Error("Reply expired");
        });
        await expect(execute()).rejects.toThrow("Reply expired");
        expect(audit.message).toHaveBeenCalledTimes(1);
    });

    test("an unexpected recorder failure does not fail a completed send", async () => {
        const { audit, interaction, execute } = fixtures();
        audit.message.mockImplementation(() => {
            throw new Error("Audit unavailable");
        });
        await execute();
        expect(interaction.editReply).toHaveBeenCalledTimes(1);
    });
});

describe("message references and media bounds", () => {
    test("parses only IDs and trusted Discord message links", () => {
        expect(parseMessageReference(messageId)).toEqual({ messageId });
        expect(
            parseMessageReference(`https://discord.com/channels/${guildId}/${channelId}/${messageId}`),
        ).toEqual({ guildId, channelId, messageId });
        for (const value of [
            "123",
            "not-a-link",
            `https://discord.com.evil.test/channels/${guildId}/${channelId}/${messageId}`,
        ]) {
            expect(() => parseMessageReference(value)).toThrow(UserError);
        }
    });

    test("honors Discord's interaction limit and caps memory at 100 MiB", () => {
        expect(mediaLimit(5 * 1_024 * 1_024)).toBe(5 * 1_024 * 1_024);
        expect(mediaLimit(1_024 * 1_024 * 1_024)).toBe(MAX_MEDIA_BYTES);
        expect(mediaLimit(NaN)).toBe(20 * 1_024 * 1_024);
        expect(uploadLimit(MAX_MEDIA_BYTES)).toBe(20 * 1_024 * 1_024);
        expect(uploadLimit(MAX_MEDIA_BYTES, 1)).toBe(20 * 1_024 * 1_024);
        expect(uploadLimit(MAX_MEDIA_BYTES, 2)).toBe(50 * 1_024 * 1_024);
        expect(uploadLimit(MAX_MEDIA_BYTES, 3)).toBe(MAX_MEDIA_BYTES);
        expect(uploadLimit(5 * 1_024 * 1_024, 3)).toBe(5 * 1_024 * 1_024);
    });

    test("rejects oversized metadata and non-CDN files before downloading", async () => {
        fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
        await expect(
            downloadMedia(
                { ...attachment, size: MAX_MEDIA_BYTES + 1 },
                MAX_MEDIA_BYTES,
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(UserError);
        await expect(
            downloadMedia(
                { ...attachment, url: "https://example.test/file.mp4" },
                MAX_MEDIA_BYTES,
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(UserError);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("rejects truncated responses instead of exposing an unwritten buffer tail", async () => {
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes.subarray(0, 2)));
        await expect(
            downloadMedia(attachment, MAX_MEDIA_BYTES, new AbortController().signal),
        ).rejects.toThrow("не полностью");
    });

    test("cancels streamed overflow before writing outside the declared buffer", async () => {
        const cancel = mock(() => {});
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(Buffer.alloc(bytes.length + 1));
                    },
                    cancel,
                }),
            ),
        );
        await expect(
            downloadMedia(attachment, MAX_MEDIA_BYTES, new AbortController().signal),
        ).rejects.toThrow("Размер вложения изменился");
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    test("bounds headers and disables redirects", async () => {
        const cancel = mock(() => {});
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(new ReadableStream({ cancel }), {
                headers: { "content-length": String(MAX_MEDIA_BYTES + 1) },
            }),
        );
        await expect(
            downloadMedia(attachment, MAX_MEDIA_BYTES, new AbortController().signal),
        ).rejects.toBeInstanceOf(UserError);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    });

    test("cancels a stalled media stream when its signal expires", async () => {
        const stalledFetch = (async (_url: URL | RequestInfo, options?: RequestInit) => {
            const signal = options?.signal;
            return new Response(
                new ReadableStream({
                    start(controller) {
                        signal?.addEventListener("abort", () => controller.error(signal.reason), {
                            once: true,
                        });
                    },
                }),
            );
        }) as typeof fetch;
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation(stalledFetch);
        await expect(
            downloadMedia(attachment, MAX_MEDIA_BYTES, AbortSignal.timeout(30)),
        ).rejects.toMatchObject({ name: "TimeoutError" });
    });
});
