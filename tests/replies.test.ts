import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import {
    ApplicationCommandType,
    MessageFlags,
    type ChatInputCommandInteraction,
    type MessageContextMenuCommandInteraction,
    type ModalSubmitInteraction,
} from "discord.js";
import { handleCommand, handleMessageCommand, handleModal } from "../src/commands.ts";
import { UserError } from "../src/discord.ts";
import { scheduleReplyDeletion } from "../src/replies.ts";
import type { Command, MessageCommand, ModalHandler, PluginContext } from "../src/types.ts";

const controllers: AbortController[] = [];
const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await settle();
    jest.useRealTimers();
});

function fixtures() {
    const controller = new AbortController();
    controllers.push(controller);
    const ctx = {
        config: { serverId: "guild", modRoleId: "mod" },
        signal: controller.signal,
        log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
        pending: new Set<Promise<unknown>>(),
    } as unknown as PluginContext;
    const interaction = {
        id: "interaction",
        ephemeral: true as boolean | null,
        deferred: false,
        replied: true,
        deleteReply: mock(async () => {}),
    };
    return { controller, ctx, interaction };
}

function commandFixtures(role = true) {
    const base = fixtures();
    const event = {
        ...base.interaction,
        ephemeral: null as boolean | null,
        deferred: false,
        replied: false,
        guildId: "guild",
        channelId: "channel",
        commandName: "test",
        customId: "test:form",
        targetId: "message",
        user: { id: "moderator" },
        memberPermissions: { has: () => false },
        member: { roles: { cache: { has: () => role } } },
        inCachedGuild: () => true,
        deferReply: mock(async (options: { flags: number }) => {
            event.deferred = true;
            event.ephemeral = Boolean(options.flags & MessageFlags.Ephemeral);
        }),
        reply: mock(async (options: { flags: number }) => {
            event.replied = true;
            event.ephemeral = Boolean(options.flags & MessageFlags.Ephemeral);
        }),
        editReply: mock(async (_content: unknown) => {
            event.replied = true;
        }),
        showModal: mock(async () => {
            event.replied = true;
        }),
    };
    return { ...base, event };
}

describe("temporary private replies", () => {
    test("deletes at exactly 15 seconds and releases the pending operation", async () => {
        const { ctx, interaction } = fixtures();
        scheduleReplyDeletion(ctx, interaction);
        jest.advanceTimersByTime(14_999);
        expect(interaction.deleteReply).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
        await settle();
        expect(ctx.pending?.size).toBe(0);
    });

    test("ignores public responses, opened modals and unacknowledged interactions", async () => {
        for (const state of [
            { ephemeral: false, replied: true, deferred: false },
            { ephemeral: null, replied: true, deferred: false },
            { ephemeral: true, replied: false, deferred: false },
        ]) {
            const { ctx, interaction } = fixtures();
            Object.assign(interaction, state);
            scheduleReplyDeletion(ctx, interaction);
            jest.advanceTimersByTime(15_000);
            expect(interaction.deleteReply).not.toHaveBeenCalled();
            expect(ctx.pending?.size).toBe(0);
        }
        await settle();
    });

    test("an already deleted response is ignored without a warning", async () => {
        const { ctx, interaction } = fixtures();
        interaction.deleteReply.mockRejectedValue({ code: 10008 });
        scheduleReplyDeletion(ctx, interaction);
        jest.advanceTimersByTime(15_000);
        await settle();
        expect(ctx.log.warn).not.toHaveBeenCalled();
        expect(ctx.pending?.size).toBe(0);
    });

    test("a failed deletion is caught, logged and removed from pending work", async () => {
        const { ctx, interaction } = fixtures();
        interaction.deleteReply.mockRejectedValue(new Error("Offline"));
        scheduleReplyDeletion(ctx, interaction);
        jest.advanceTimersByTime(15_000);
        await settle();
        expect(ctx.log.warn).toHaveBeenCalledTimes(1);
        expect(ctx.pending?.size).toBe(0);
    });

    test("shutdown cancels a future deletion", async () => {
        const { controller, ctx, interaction } = fixtures();
        scheduleReplyDeletion(ctx, interaction);
        controller.abort();
        jest.advanceTimersByTime(60_000);
        await settle();
        expect(interaction.deleteReply).not.toHaveBeenCalled();
        expect(ctx.pending?.size).toBe(0);
    });

    test("in-flight deletion is tracked and cancellation does not emit a warning", async () => {
        const { controller, ctx, interaction } = fixtures();
        const barrier = Promise.withResolvers<void>();
        interaction.deleteReply.mockImplementation(async () => {
            await barrier.promise;
            throw new Error("Cancelled");
        });
        scheduleReplyDeletion(ctx, interaction);
        jest.advanceTimersByTime(15_000);
        expect(ctx.pending?.size).toBe(1);
        controller.abort();
        barrier.resolve();
        await settle();
        expect(ctx.log.warn).not.toHaveBeenCalled();
        expect(ctx.pending?.size).toBe(0);
    });
});

describe("reply cleanup through command routes", () => {
    test("a long operation gets 15 seconds after its final response, not after defer", async () => {
        const { ctx, event } = commandFixtures();
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const command: Command = {
            data: { name: "test", description: "test" },
            async execute() {
                started.resolve();
                await finish.promise;
                await event.editReply("Completed");
            },
        };
        const pending = handleCommand(
            ctx,
            new Map([["test", command]]),
            event as unknown as ChatInputCommandInteraction,
        );
        await started.promise;
        expect(event.deferred).toBe(true);
        jest.advanceTimersByTime(30_000);
        expect(event.deleteReply).not.toHaveBeenCalled();
        finish.resolve();
        await pending;
        jest.advanceTimersByTime(14_999);
        expect(event.deleteReply).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        await settle();
        expect(event.deleteReply).toHaveBeenCalledTimes(1);
    });

    test("a private permission denial is also deleted after 15 seconds", async () => {
        const { ctx, event } = commandFixtures(false);
        await handleCommand(ctx, new Map(), event as unknown as ChatInputCommandInteraction);
        expect(event.reply).toHaveBeenCalledTimes(1);
        expect(event.ephemeral).toBe(true);
        jest.advanceTimersByTime(15_000);
        await settle();
        expect(event.deleteReply).toHaveBeenCalledTimes(1);
    });

    test("opening the editor modal does not schedule deletion of a response", async () => {
        const { ctx, event } = commandFixtures();
        const command: MessageCommand = {
            data: { name: "test", type: ApplicationCommandType.Message },
            async execute() {
                await event.showModal();
            },
        };
        await handleMessageCommand(
            ctx,
            new Map([["test", command]]),
            event as unknown as MessageContextMenuCommandInteraction,
        );
        expect(event.replied).toBe(true);
        expect(event.ephemeral).toBeNull();
        jest.advanceTimersByTime(15_000);
        await settle();
        expect(event.deleteReply).not.toHaveBeenCalled();
    });

    test("a modal submission confirmation is deleted after 15 seconds", async () => {
        const { ctx, event } = commandFixtures();
        const handler: ModalHandler = {
            prefix: "test:",
            async execute() {
                await event.editReply("Saved");
            },
        };
        await handleModal(ctx, [handler], event as unknown as ModalSubmitInteraction);
        expect(event.ephemeral).toBe(true);
        jest.advanceTimersByTime(15_000);
        await settle();
        expect(event.deleteReply).toHaveBeenCalledTimes(1);
    });

    test("private command error responses get the same lifetime", async () => {
        const { ctx, event } = commandFixtures();
        const command: Command = {
            data: { name: "test", description: "test" },
            async execute() {
                throw new UserError("Invalid input");
            },
        };
        await handleCommand(
            ctx,
            new Map([["test", command]]),
            event as unknown as ChatInputCommandInteraction,
        );
        expect(event.editReply).toHaveBeenCalledWith({ content: "Invalid input" });
        jest.advanceTimersByTime(15_000);
        await settle();
        expect(event.deleteReply).toHaveBeenCalledTimes(1);
    });
});
