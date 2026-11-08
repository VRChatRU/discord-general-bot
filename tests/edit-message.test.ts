import { describe, expect, mock, test } from "bun:test";
import {
    ApplicationCommandType,
    ChannelType,
    ComponentType,
    ModalBuilder,
    PermissionFlagsBits,
    TextInputStyle,
    type MessageContextMenuCommandInteraction,
    type ModalSubmitInteraction,
} from "discord.js";
import { createEditMessagePlugin } from "../plugins/edit-message.ts";
import { getTextChannel, UserError } from "../src/discord.ts";
import type { PluginContext } from "../src/types.ts";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const messageId = "333333333333333333";
const botId = "444444444444444444";
const userId = "555555555555555555";
const id = `edit-message:${userId}:${channelId}:${messageId}`;

function fixtures() {
    const controller = new AbortController();
    const result = {
        url: "https://discord.com/message",
        content: undefined as string | undefined,
        attachments: undefined as Map<string, { name: string; url: string }> | undefined,
    };
    const original = {
        id: messageId,
        channelId,
        author: { id: botId },
        content: "Original text",
        attachments: new Map([
            [
                "media",
                { id: "media", name: "clip.mp4", url: "https://cdn.discordapp.com/attachments/clip.mp4" },
            ],
        ]),
        embeds: [] as unknown[],
        components: [] as unknown[],
        stickers: new Map<string, unknown>(),
        poll: null as unknown,
        edit: mock(async (_options: unknown) => result),
    };
    const channel = {
        id: channelId,
        guildId,
        type: ChannelType.GuildText as ChannelType,
        isThread: () => false,
        permissionsFor: mock(() => ({ has: (_permission: unknown): boolean => true })),
        messages: { fetch: mock(async (_id: string) => original) },
    };
    const audit = { message: mock((_event: unknown) => {}) };
    const ctx = {
        client: { user: { id: botId }, channels: { fetch: mock(async (_id: string) => channel) } },
        config: { serverId: guildId },
        signal: controller.signal,
        log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
        audit,
    } as unknown as PluginContext;
    const plugin = createEditMessagePlugin(ctx);
    const context = {
        user: { id: userId },
        channelId,
        targetMessage: original,
        showModal: mock(async (_modal: ModalBuilder) => {}),
        deferReply: mock(async () => {}),
    };
    const submission = {
        user: { id: userId },
        channelId,
        customId: id,
        fields: { getTextInputValue: mock((_field: string) => "Changed @everyone text") },
        editReply: mock(async (_content: string) => {}),
    };
    const open = () =>
        plugin.messageCommands![0]!.execute(
            context as unknown as MessageContextMenuCommandInteraction<"cached">,
        );
    const submit = () =>
        plugin.modals![0]!.execute(submission as unknown as ModalSubmitInteraction<"cached">);
    return { controller, plugin, ctx, audit, result, channel, original, context, submission, open, submit };
}

describe("bot message context editor", () => {
    test("registers a message context command with moderator visibility defaults", () => {
        const { plugin } = fixtures();
        expect(plugin.commands).toBeUndefined();
        expect(plugin.messageCommands?.[0]?.data).toMatchObject({
            name: "Редактировать сообщение бота",
            type: ApplicationCommandType.Message,
            default_member_permissions: String(PermissionFlagsBits.ManageMessages),
        });
        expect(plugin.modals?.[0]?.prefix).toBe("edit-message:");
    });

    test("another author's message gets a safe error without opening a modal", async () => {
        const { original, context, ctx, open } = fixtures();
        original.author.id = "666666666666666666";
        await expect(open()).rejects.toThrow("только сообщения этого бота");
        expect(context.showModal).not.toHaveBeenCalled();
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
    });

    test("opens a prefilled modern text modal immediately without network fetch or defer", async () => {
        const { context, ctx, open } = fixtures();
        await open();
        expect(context.showModal).toHaveBeenCalledTimes(1);
        expect(context.deferReply).not.toHaveBeenCalled();
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
        const modal = context.showModal.mock.calls[0]![0].toJSON();
        expect(modal.custom_id).toBe(id);
        expect(modal.custom_id.length).toBeLessThanOrEqual(100);
        expect(modal.components).toEqual([
            {
                type: ComponentType.Label,
                label: "Текст сообщения",
                component: {
                    type: ComponentType.TextInput,
                    custom_id: "message",
                    style: TextInputStyle.Paragraph,
                    max_length: 2_000,
                    required: false,
                    value: "Original text",
                },
            },
        ]);
    });

    test("an attachment-only message opens with an empty text field", async () => {
        const { original, context, open } = fixtures();
        original.content = "";
        await open();
        const modal = context.showModal.mock.calls[0]![0].toJSON();
        const label = modal.components[0]!;
        expect(label).toMatchObject({ component: { value: "", required: false } });
    });

    test("submission refetches the exact message and edits only text, preserving all media", async () => {
        const { ctx, channel, original, submission, submit } = fixtures();
        await submit();
        expect(ctx.client.channels.fetch).toHaveBeenCalledWith(channelId);
        expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
        expect(original.edit).toHaveBeenCalledWith({
            content: "Changed @everyone text",
            allowedMentions: { parse: [] },
        });
        const payload = original.edit.mock.calls[0]![0] as Record<string, unknown>;
        for (const field of ["attachments", "files", "embeds", "components"])
            expect(payload).not.toHaveProperty(field);
        expect(original.attachments.size).toBe(1);
        expect(submission.editReply).toHaveBeenCalledTimes(1);
        expect(ctx.log.info).toHaveBeenCalledTimes(1);
    });

    test("saves a bot message in a thread and preserves its media", async () => {
        const { channel, original, submit } = fixtures();
        channel.type = ChannelType.PublicThread;
        channel.isThread = () => true;
        const has = mock((permissions: unknown) =>
            Array.isArray(permissions)
                ? permissions.every((permission) => permission !== PermissionFlagsBits.SendMessages)
                : true,
        );
        channel.permissionsFor.mockReturnValue({ has });
        await submit();
        expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
        expect(original.edit).toHaveBeenCalledWith({
            content: "Changed @everyone text",
            allowedMentions: { parse: [] },
        });
        expect(original.attachments.size).toBe(1);
        expect(has).toHaveBeenCalledWith([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessagesInThreads,
        ]);
    });

    test("a thread in another guild is rejected before fetching its message", async () => {
        const { channel, original, submit } = fixtures();
        channel.type = ChannelType.PrivateThread;
        channel.isThread = () => true;
        channel.guildId = "888888888888888888";
        await expect(submit()).rejects.toBeInstanceOf(UserError);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("missing thread-send permission prevents fetching or editing a thread message", async () => {
        const { channel, original, submit } = fixtures();
        channel.type = ChannelType.PublicThread;
        channel.isThread = () => true;
        channel.permissionsFor.mockReturnValue({
            has: (permissions) =>
                Array.isArray(permissions)
                    ? !permissions.includes(PermissionFlagsBits.SendMessagesInThreads)
                    : true,
        });
        await expect(submit()).rejects.toThrow("в ветках");
        expect(channel.messages.fetch).not.toHaveBeenCalled();
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("thread support remains opt-in for the existing say and sticky channel helper", async () => {
        const { channel, ctx } = fixtures();
        channel.type = ChannelType.PublicThread;
        channel.isThread = () => true;
        await expect(getTextChannel(ctx, channelId)).rejects.toBeInstanceOf(UserError);
        await expect(getTextChannel(ctx, channelId, true)).rejects.toBeInstanceOf(UserError);
    });

    test("modal IDs are stateless and work after constructing a fresh plugin instance", async () => {
        const { ctx, submission, original } = fixtures();
        const restarted = createEditMessagePlugin(ctx);
        await restarted.modals![0]!.execute(submission as unknown as ModalSubmitInteraction<"cached">);
        expect(original.edit).toHaveBeenCalledTimes(1);
    });

    test("forged, malformed and cross-channel forms are rejected before fetching", async () => {
        const { ctx, submission, submit } = fixtures();
        for (const customId of [
            "edit-message:invalid",
            `edit-message:666666666666666666:${channelId}:${messageId}`,
            `edit-message:${userId}:777777777777777777:${messageId}`,
            `${id}:extra`,
        ]) {
            submission.customId = customId;
            await expect(submit()).rejects.toBeInstanceOf(UserError);
        }
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
    });

    test("a different guild channel is rejected before fetching or editing its message", async () => {
        const { channel, original, submit } = fixtures();
        channel.guildId = "888888888888888888";
        await expect(submit()).rejects.toBeInstanceOf(UserError);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("a fresh ownership check prevents editing another author's message", async () => {
        const { original, submit } = fixtures();
        original.author.id = "666666666666666666";
        await expect(submit()).rejects.toThrow("только сообщения этого бота");
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("missing history permission prevents message fetch and edit", async () => {
        const { channel, original, submit } = fixtures();
        channel.permissionsFor.mockReturnValue({
            has: (permission) => permission !== PermissionFlagsBits.ReadMessageHistory,
        });
        await expect(submit()).rejects.toThrow("историю");
        expect(channel.messages.fetch).not.toHaveBeenCalled();
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("clearing text keeps existing media, but a fully empty message is rejected", async () => {
        const { original, submission, submit } = fixtures();
        submission.fields.getTextInputValue.mockReturnValue("");
        await submit();
        expect(original.edit).toHaveBeenCalledWith({ content: "", allowedMentions: { parse: [] } });
        original.edit.mockClear();
        original.attachments.clear();
        await expect(submit()).rejects.toThrow("не может быть пустым");
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("blank content is allowed when an existing embed remains", async () => {
        const { original, submission, submit } = fixtures();
        original.attachments.clear();
        original.embeds.push({ description: "Existing embed" });
        submission.fields.getTextInputValue.mockReturnValue("");
        await submit();
        expect(original.edit).toHaveBeenCalledWith({ content: "", allowedMentions: { parse: [] } });
    });

    test("deleted messages and lost permissions report safe errors without editing", async () => {
        const { channel, original, submit } = fixtures();
        channel.messages.fetch.mockRejectedValueOnce(
            Object.assign(new Error("Unknown message"), { code: 10008 }),
        );
        await expect(submit()).rejects.toThrow("удалено");
        channel.messages.fetch.mockRejectedValueOnce(
            Object.assign(new Error("Missing permissions"), { code: 50013 }),
        );
        await expect(submit()).rejects.toThrow("недостаточно прав");
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("oversized text cannot reach Discord even with a forged modal payload", async () => {
        const { original, ctx, submission, submit } = fixtures();
        submission.fields.getTextInputValue.mockReturnValue("x".repeat(2_001));
        await expect(submit()).rejects.toThrow("2000");
        expect(ctx.client.channels.fetch).not.toHaveBeenCalled();
        expect(original.edit).not.toHaveBeenCalled();
    });

    test("network failures propagate to the core error boundary without a false success reply", async () => {
        const { original, submission, submit } = fixtures();
        original.edit.mockRejectedValue(new Error("Offline"));
        await expect(submit()).rejects.toThrow("Offline");
        expect(original.edit).toHaveBeenCalledTimes(1);
        expect(submission.editReply).not.toHaveBeenCalled();
    });

    test("shutdown prevents opening or editing a message", async () => {
        const { controller, context, original, open, submit } = fixtures();
        controller.abort();
        await expect(open()).rejects.toBeDefined();
        await expect(submit()).rejects.toBeDefined();
        expect(context.showModal).not.toHaveBeenCalled();
        expect(original.edit).not.toHaveBeenCalled();
    });
});

describe("context editor audit records", () => {
    test("records only successful edits with actor, channel and existing media", async () => {
        const { open, submit, audit } = fixtures();
        await open();
        expect(audit.message).not.toHaveBeenCalled();
        await submit();
        expect(audit.message).toHaveBeenCalledWith({
            action: "edited",
            actorId: userId,
            channelId,
            messageId,
            content: "Changed @everyone text",
            previousContent: "Original text",
            attachments: [{ name: "clip.mp4", url: "https://cdn.discordapp.com/attachments/clip.mp4" }],
            source: "context-menu",
        });
    });

    test("captures old content before an edit mutates the original cache object", async () => {
        const { original, result, submit, audit } = fixtures();
        result.content = "Actual edited text";
        original.edit.mockImplementation(async () => {
            original.content = "Cache changed";
            return result;
        });
        await submit();
        expect(audit.message.mock.calls[0]?.[0]).toMatchObject({
            content: "Actual edited text",
            previousContent: "Original text",
        });
    });

    test("does not audit failed edits, but records a successful edit before a failed reply", async () => {
        const { original, result, submission, audit, submit } = fixtures();
        original.edit.mockRejectedValue(new Error("Edit failed"));
        await expect(submit()).rejects.toThrow("Edit failed");
        expect(audit.message).not.toHaveBeenCalled();
        original.edit.mockResolvedValue(result);
        submission.editReply.mockImplementation(async () => {
            expect(audit.message).toHaveBeenCalledTimes(1);
            throw new Error("Reply expired");
        });
        await expect(submit()).rejects.toThrow("Reply expired");
        expect(audit.message).toHaveBeenCalledTimes(1);
    });

    test("an unavailable recorder does not fail an already completed edit", async () => {
        const { audit, submission, submit } = fixtures();
        audit.message.mockImplementation(() => {
            throw new Error("Audit unavailable");
        });
        await submit();
        expect(submission.editReply).toHaveBeenCalledTimes(1);
    });
});
