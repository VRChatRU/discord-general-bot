import {
    MessageFlags,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
    type MessageContextMenuCommandInteraction,
    type ModalSubmitInteraction,
} from "discord.js";
import { UserError } from "./discord.ts";
import { scheduleReplyDeletion } from "./replies.ts";
import type { Command, MessageCommand, ModalHandler, PluginContext } from "./types.ts";

type ManagedInteraction =
    ChatInputCommandInteraction | MessageContextMenuCommandInteraction | ModalSubmitInteraction;
type CachedInteraction =
    | ChatInputCommandInteraction<"cached">
    | MessageContextMenuCommandInteraction<"cached">
    | ModalSubmitInteraction<"cached">;

export function isModerator(interaction: CachedInteraction, roleId: string): boolean {
    return (
        interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
        interaction.member.roles.cache.has(roleId)
    );
}

function isAllowed(ctx: PluginContext, interaction: ManagedInteraction): interaction is CachedInteraction {
    return (
        interaction.inCachedGuild() &&
        interaction.guildId === ctx.config.serverId &&
        isModerator(interaction, ctx.config.modRoleId)
    );
}

async function deny(interaction: ManagedInteraction): Promise<void> {
    await interaction.reply({
        content: "Эта команда доступна только модераторам сервера.",
        flags: MessageFlags.Ephemeral,
    });
}

async function reportFailure(
    ctx: PluginContext,
    interaction: ManagedInteraction,
    error: unknown,
): Promise<void> {
    if (ctx.signal.aborted) return;
    const command = "commandName" in interaction ? interaction.commandName : interaction.customId;
    ctx.log.warn("Interaction failed", { command, userId: interaction.user.id, error });
    const content =
        error instanceof UserError
            ? error.message
            : "Не удалось выполнить команду. Проверьте права бота или попробуйте позже.";
    try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
        ctx.log.warn("Could not deliver command response", { command, error: replyError });
    }
}

export async function handleCommand(
    ctx: PluginContext,
    commands: Map<string, Command>,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    if (ctx.signal.aborted) return;
    try {
        if (!isAllowed(ctx, interaction)) {
            await deny(interaction);
            return;
        }
        const command = commands.get(interaction.commandName);
        if (!command) {
            await interaction.reply({
                content: "Команда устарела. Обновите Discord и попробуйте снова.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        ctx.log.info("Executing slash command", {
            command: interaction.commandName,
            userId: interaction.user.id,
            channelId: interaction.channelId,
        });
        await command.execute(interaction);
    } catch (error) {
        await reportFailure(ctx, interaction, error);
    } finally {
        scheduleReplyDeletion(ctx, interaction);
    }
}

export async function handleMessageCommand(
    ctx: PluginContext,
    commands: Map<string, MessageCommand>,
    interaction: MessageContextMenuCommandInteraction,
): Promise<void> {
    if (ctx.signal.aborted) return;
    try {
        if (!isAllowed(ctx, interaction)) {
            await deny(interaction);
            return;
        }
        const command = commands.get(interaction.commandName);
        if (!command) throw new UserError("Команда устарела. Обновите Discord и попробуйте снова.");
        ctx.log.info("Executing message command", {
            command: interaction.commandName,
            userId: interaction.user.id,
            channelId: interaction.channelId,
            messageId: interaction.targetId,
        });
        // A modal must be the first response; the plugin opens it without deferring.
        await command.execute(interaction);
    } catch (error) {
        await reportFailure(ctx, interaction, error);
    } finally {
        scheduleReplyDeletion(ctx, interaction);
    }
}

export async function handleModal(
    ctx: PluginContext,
    handlers: ModalHandler[],
    interaction: ModalSubmitInteraction,
): Promise<void> {
    if (ctx.signal.aborted) return;
    try {
        if (!isAllowed(ctx, interaction)) {
            await deny(interaction);
            return;
        }
        const handler = handlers.find((item) => interaction.customId.startsWith(item.prefix));
        if (!handler) throw new UserError("Форма устарела. Откройте редактирование сообщения заново.");
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        ctx.log.info("Processing modal submission", {
            form: handler.prefix,
            userId: interaction.user.id,
            channelId: interaction.channelId,
        });
        await handler.execute(interaction);
    } catch (error) {
        await reportFailure(ctx, interaction, error);
    } finally {
        scheduleReplyDeletion(ctx, interaction);
    }
}
