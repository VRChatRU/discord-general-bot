import {
    ApplicationCommandType,
    ContextMenuCommandBuilder,
    LabelBuilder,
    ModalBuilder,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { discordErrorCode, getTextChannel, UserError } from "../src/discord.ts";
import type { Plugin, PluginContext } from "../src/types.ts";

const modalPrefix = "edit-message:";
const modalId = /^edit-message:(\d{17,20}):(\d{17,20}):(\d{17,20})$/;

function friendlyError(error: unknown): unknown {
    switch (discordErrorCode(error)) {
        case 10008:
            return new UserError("Сообщение удалено или недоступно. Откройте редактор заново.");
        case 10003:
            return new UserError("Канал удалён или недоступен боту.");
        case 50001:
        case 50013:
            return new UserError("У бота недостаточно прав для редактирования сообщения.");
        default:
            return error;
    }
}

export function createEditMessagePlugin(ctx: PluginContext): Plugin {
    return {
        name: "edit-message",
        messageCommands: [
            {
                data: new ContextMenuCommandBuilder()
                    .setName("Редактировать сообщение бота")
                    .setType(ApplicationCommandType.Message)
                    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
                    .toJSON(),
                async execute(interaction) {
                    ctx.signal.throwIfAborted();
                    const original = interaction.targetMessage;
                    if (original.author.id !== ctx.client.user?.id) {
                        throw new UserError("Редактировать можно только сообщения этого бота.");
                    }
                    const text = new TextInputBuilder()
                        .setCustomId("message")
                        .setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(2_000)
                        .setRequired(false)
                        .setValue(original.content);
                    const modal = new ModalBuilder()
                        .setCustomId(
                            `${modalPrefix}${interaction.user.id}:${original.channelId}:${original.id}`,
                        )
                        .setTitle("Редактировать сообщение бота")
                        .addLabelComponents(
                            new LabelBuilder().setLabel("Текст сообщения").setTextInputComponent(text),
                        );
                    await interaction.showModal(modal);
                    ctx.log.info("Opened bot message editor", {
                        actorId: interaction.user.id,
                        channelId: original.channelId,
                        messageId: original.id,
                    });
                },
            },
        ],
        modals: [
            {
                prefix: modalPrefix,
                async execute(interaction) {
                    const match = modalId.exec(interaction.customId);
                    if (!match || match[1] !== interaction.user.id || match[2] !== interaction.channelId) {
                        throw new UserError("Эта форма недействительна. Откройте редактор заново.");
                    }
                    const channelId = match[2]!;
                    const messageId = match[3]!;
                    const content = interaction.fields.getTextInputValue("message");
                    if (content.length > 2_000)
                        throw new UserError("Текст не должен превышать 2000 символов.");
                    try {
                        const channel = await getTextChannel(ctx, channelId, false, true);
                        if (
                            !channel
                                .permissionsFor(ctx.client.user!)
                                ?.has(PermissionFlagsBits.ReadMessageHistory)
                        ) {
                            throw new UserError(
                                "Для редактирования боту нужно право «Читать историю сообщений».",
                            );
                        }
                        const original = await channel.messages.fetch(messageId);
                        if (original.author.id !== ctx.client.user?.id) {
                            throw new UserError("Редактировать можно только сообщения этого бота.");
                        }
                        if (
                            !content.trim() &&
                            !original.attachments.size &&
                            !original.embeds.length &&
                            !original.components.length &&
                            !original.stickers.size &&
                            !original.poll
                        ) {
                            throw new UserError("Сообщение без медиа не может быть пустым.");
                        }
                        ctx.signal.throwIfAborted();
                        const previousContent = original.content;
                        const updated = await original.edit({ content, allowedMentions: { parse: [] } });
                        ctx.log.info("Edited bot message text", {
                            actorId: interaction.user.id,
                            channelId,
                            messageId,
                            length: content.length,
                        });
                        try {
                            await ctx.audit?.message({
                                action: "edited",
                                actorId: interaction.user.id,
                                channelId,
                                messageId,
                                content: updated.content ?? content,
                                previousContent,
                                attachments: Array.from(
                                    updated.attachments?.values() ?? original.attachments?.values() ?? [],
                                ).map(({ name, url }) => ({ name, url })),
                                source: "context-menu",
                            });
                        } catch (error) {
                            ctx.log.warn("Could not record message audit", { channelId, messageId, error });
                        }
                        await interaction.editReply(`Сообщение изменено: ${updated.url}`);
                    } catch (error) {
                        throw friendlyError(error);
                    }
                },
            },
        ],
    };
}
