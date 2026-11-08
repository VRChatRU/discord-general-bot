import { describe, expect, mock, test } from "bun:test";
import {
    ApplicationCommandType,
    MessageFlags,
    PermissionFlagsBits,
    type MessageContextMenuCommandInteraction,
    type ModalSubmitInteraction,
} from "discord.js";
import { handleMessageCommand, handleModal } from "../src/commands.ts";
import type { MessageCommand, ModalHandler, PluginContext } from "../src/types.ts";

const commandName = "Редактировать сообщение бота";
const routes = ["context menu", "modal"] as const;

function fixtures({ role = true, admin = false, guild = "guild", cached = true } = {}) {
    const controller = new AbortController();
    const authorization = { role, admin, cached };
    const operations: string[] = [];
    const log = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
    const ctx = {
        config: { serverId: "guild", modRoleId: "mod" },
        signal: controller.signal,
        log,
    } as unknown as PluginContext;

    function interaction() {
        const event = {
            guildId: guild,
            channelId: "channel",
            user: { id: "moderator" },
            memberPermissions: {
                has: (permission: bigint) =>
                    permission === PermissionFlagsBits.Administrator && authorization.admin,
            },
            member: { roles: { cache: { has: (id: string) => id === "mod" && authorization.role } } },
            inCachedGuild: () => authorization.cached,
            replied: false,
            deferred: false,
            reply: mock(async (_options: unknown) => {
                operations.push("reply");
                event.replied = true;
            }),
            editReply: mock(async (_options: unknown) => {
                operations.push("editReply");
            }),
            deferReply: mock(async (_options: unknown) => {
                operations.push("defer");
                event.deferred = true;
            }),
        };
        return event;
    }

    const context = Object.assign(interaction(), {
        commandName,
        targetId: "message",
        showModal: mock(async (_modal: unknown) => {}),
    });
    context.showModal.mockImplementation(async () => {
        operations.push("showModal");
        context.replied = true;
    });
    const modal = Object.assign(interaction(), { customId: "edit:owner:channel:message" });
    const openCallback = mock(async () => {
        operations.push("open");
        await context.showModal({ custom_id: modal.customId });
    });
    const submitCallback = mock(async () => {
        operations.push("submit");
    });
    const command: MessageCommand = {
        data: { name: commandName, type: ApplicationCommandType.Message },
        execute: openCallback,
    };
    const handler: ModalHandler = { prefix: "edit:", execute: submitCallback };
    const open = () =>
        handleMessageCommand(
            ctx,
            new Map([[commandName, command]]),
            context as unknown as MessageContextMenuCommandInteraction,
        );
    const submit = () => handleModal(ctx, [handler], modal as unknown as ModalSubmitInteraction);
    const route = (kind: (typeof routes)[number]) =>
        kind === "context menu"
            ? { run: open, event: context, callback: openCallback }
            : { run: submit, event: modal, callback: submitCallback };
    return {
        controller,
        authorization,
        operations,
        log,
        context,
        modal,
        openCallback,
        submitCallback,
        open,
        submit,
        route,
    };
}

describe("message editor authorization", () => {
    test.each(routes)("rejects ordinary members at the %s boundary", async (kind) => {
        const fixture = fixtures({ role: false });
        const { run, event, callback } = fixture.route(kind);
        await run();
        expect(callback).not.toHaveBeenCalled();
        expect(event.deferReply).not.toHaveBeenCalled();
        expect(event.reply).toHaveBeenCalledWith({
            content: "Эта команда доступна только модераторам сервера.",
            flags: MessageFlags.Ephemeral,
        });
    });

    test.each(routes)("allows the configured moderator role at the %s boundary", async (kind) => {
        const { run, callback } = fixtures().route(kind);
        await run();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    test.each(routes)("allows administrators at the %s boundary without the moderator role", async (kind) => {
        const { run, callback } = fixtures({ role: false, admin: true }).route(kind);
        await run();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    test.each(routes)(
        "rejects a different guild at the %s boundary even for an administrator",
        async (kind) => {
            const { run, callback, event } = fixtures({ admin: true, guild: "other-guild" }).route(kind);
            await run();
            expect(callback).not.toHaveBeenCalled();
            expect(event.reply).toHaveBeenCalledTimes(1);
        },
    );

    test.each(routes)("rejects an uncached guild at the %s boundary", async (kind) => {
        const { run, callback } = fixtures({ cached: false }).route(kind);
        await run();
        expect(callback).not.toHaveBeenCalled();
    });

    test("revoking the moderator role after opening prevents submission", async () => {
        const { authorization, open, submit, context, modal, submitCallback } = fixtures();
        await open();
        expect(context.showModal).toHaveBeenCalledTimes(1);
        authorization.role = false;
        await submit();
        expect(submitCallback).not.toHaveBeenCalled();
        expect(modal.deferReply).not.toHaveBeenCalled();
        expect(modal.reply.mock.calls[0]?.[0]).toMatchObject({ flags: MessageFlags.Ephemeral });
    });
});

describe("message editor interaction responses", () => {
    test("opens a modal as the initial response without deferring", async () => {
        const { open, context, operations } = fixtures();
        await open();
        expect(operations).toEqual(["open", "showModal"]);
        expect(context.deferReply).not.toHaveBeenCalled();
        expect(context.reply).not.toHaveBeenCalled();
    });

    test("awaits a private deferred response before processing a modal submission", async () => {
        const { submit, modal, submitCallback, operations } = fixtures();
        let release!: () => void;
        modal.deferReply.mockImplementation(async () => {
            operations.push("defer-start");
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            modal.deferred = true;
            operations.push("defer-complete");
        });
        const pending = submit();
        try {
            await Promise.resolve();
            expect(submitCallback).not.toHaveBeenCalled();
            expect(modal.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        } finally {
            release();
        }
        await pending;
        expect(operations).toEqual(["defer-start", "defer-complete", "submit"]);
    });

    test("an unknown modal prefix receives a friendly private response", async () => {
        const { submit, modal, submitCallback } = fixtures();
        modal.customId = "removed-plugin:old-form";
        await submit();
        expect(submitCallback).not.toHaveBeenCalled();
        expect(modal.deferReply).not.toHaveBeenCalled();
        expect(modal.reply).toHaveBeenCalledWith({
            content: "Форма устарела. Откройте редактирование сообщения заново.",
            flags: MessageFlags.Ephemeral,
        });
    });

    test.each(routes)("a failed %s operation and failed error response do not escape", async (kind) => {
        const fixture = fixtures();
        const { run, event, callback } = fixture.route(kind);
        callback.mockRejectedValue(new Error("Discord unavailable"));
        event.reply.mockRejectedValue(new Error("Interaction expired"));
        event.editReply.mockRejectedValue(new Error("Interaction expired"));
        await expect(run()).resolves.toBeUndefined();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(fixture.log.warn).toHaveBeenCalledTimes(2);
    });

    test.each(routes)("an aborted context does nothing for the %s route", async (kind) => {
        const fixture = fixtures();
        const { run, event, callback } = fixture.route(kind);
        fixture.controller.abort();
        await run();
        expect(callback).not.toHaveBeenCalled();
        expect(event.reply).not.toHaveBeenCalled();
        expect(event.deferReply).not.toHaveBeenCalled();
        expect(fixture.log.info).not.toHaveBeenCalled();
        expect(fixture.log.warn).not.toHaveBeenCalled();
    });
});
