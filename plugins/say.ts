import {
    ChannelType,
    PermissionFlagsBits,
    SlashCommandBuilder,
    type DMChannel,
    type Message,
    type NewsChannel,
    type PartialDMChannel,
    type TextChannel,
} from "discord.js";
import { discordErrorCode, getTextChannel, UserError } from "../src/discord.ts";
import { downloadMedia, uploadLimit } from "../src/media.ts";
import type { Plugin, PluginContext } from "../src/types.ts";

const snowflake = /^\d{17,20}$/;
const MESSAGE_HOSTS = new Set([
    "discord.com",
    "www.discord.com",
    "canary.discord.com",
    "ptb.discord.com",
    "discordapp.com",
]);

interface MessageReference {
    messageId: string;
    channelId?: string;
    guildId?: string;
}

export function parseMessageReference(value: string): MessageReference {
    if (snowflake.test(value)) return { messageId: value };
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new UserError("Укажи ID сообщения или ссылку на сообщение Discord.");
    }
    const match = /^\/channels\/(@me|\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/.exec(url.pathname);
    if (
        url.protocol !== "https:" ||
        !MESSAGE_HOSTS.has(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        !match
    ) {
        throw new UserError("Укажи ID сообщения или ссылку на сообщение Discord.");
    }
    return { guildId: match[1]!, channelId: match[2]!, messageId: match[3]! };
}

function friendlyDiscordError(error: unknown): unknown {
    switch (discordErrorCode(error)) {
        case 50007:
            return new UserError(
                "Не удалось отправить ЛС: пользователь закрыл личные сообщения или недоступен для бота.",
            );
        case 10008:
            return new UserError("Сообщение не найдено в выбранном канале. Проверь ID или ссылку.");
        case 10003:
            return new UserError("Канал не найден или недоступен боту.");
        case 10013:
            return new UserError("Пользователь не найден.");
        case 40005:
            return new UserError("Медиа превышает лимит Discord для выбранного канала или ЛС.");
        case 50001:
        case 50013:
            return new UserError("У бота недостаточно прав для этой операции.");
        default:
            return error;
    }
}

export function createSayPlugin(ctx: PluginContext): Plugin {
    let mediaBusy = false;

    return {
        name: "say",
        commands: [
            {
                data: new SlashCommandBuilder()
                    .setName("say")
                    .setDescription("Отправить или изменить сообщение от имени бота")
                    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
                    .addUserOption((option) =>
                        option.setName("user").setDescription("Получатель личного сообщения"),
                    )
                    .addChannelOption((option) =>
                        option
                            .setName("channel")
                            .setDescription("Канал; по умолчанию текущий канал")
                            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
                    )
                    .addStringOption((option) =>
                        option
                            .setName("message-id")
                            .setDescription("ID или ссылка на сообщение бота для редактирования")
                            .setMaxLength(200),
                    )
                    .addStringOption((option) =>
                        option
                            .setName("message")
                            .setDescription("Текст сообщения")
                            .setMinLength(1)
                            .setMaxLength(2_000),
                    )
                    .addAttachmentOption((option) =>
                        option
                            .setName("media")
                            .setDescription("Изображение, видео, аудио или другой файл до 100 МиБ"),
                    )
                    .toJSON(),
                async execute(interaction) {
                    const user = interaction.options.getUser("user");
                    const selectedChannel = interaction.options.getChannel("channel");
                    const messageInput = interaction.options.getString("message-id");
                    const rawContent = interaction.options.getString("message");
                    const content = rawContent?.trim() ? rawContent : undefined;
                    const media = interaction.options.getAttachment("media");
                    if (user && selectedChannel) throw new UserError("Выбери либо пользователя, либо канал.");
                    if (!content && !media) throw new UserError("Укажи текст сообщения или прикрепи медиа.");
                    if (content && content.length > 2_000)
                        throw new UserError("Текст не должен превышать 2000 символов.");
                    const reference =
                        messageInput === null ? undefined : parseMessageReference(messageInput.trim());
                    if (
                        reference?.guildId &&
                        reference.guildId !== "@me" &&
                        reference.guildId !== ctx.config.serverId
                    ) {
                        throw new UserError(
                            "Можно редактировать сообщения только на этом сервере или в выбранных ЛС.",
                        );
                    }
                    if (media && mediaBusy)
                        throw new UserError("Бот уже обрабатывает медиа. Попробуй чуть позже.");
                    if (media) mediaBusy = true;
                    try {
                        let channel: TextChannel | NewsChannel | DMChannel | PartialDMChannel;
                        if (user) {
                            if (reference?.guildId && reference.guildId !== "@me") {
                                throw new UserError(
                                    "Ссылка ведёт на сервер. Выбери канал вместо пользователя.",
                                );
                            }
                            channel = await user.createDM();
                            if (reference?.channelId && reference.channelId !== channel.id) {
                                throw new UserError("Ссылка не относится к ЛС выбранного пользователя.");
                            }
                        } else if (reference?.guildId === "@me") {
                            if (selectedChannel)
                                throw new UserError(
                                    "Ссылка ведёт в ЛС и не совпадает с выбранным каналом сервера.",
                                );
                            const target = await ctx.client.channels.fetch(reference.channelId!);
                            if (!target || target.type !== ChannelType.DM) {
                                throw new UserError("Личные сообщения по этой ссылке недоступны боту.");
                            }
                            channel = target;
                        } else {
                            if (
                                reference?.channelId &&
                                selectedChannel &&
                                selectedChannel.id !== reference.channelId
                            ) {
                                throw new UserError("Ссылка и выбранный канал не совпадают.");
                            }
                            channel = await getTextChannel(
                                ctx,
                                reference?.channelId ?? selectedChannel?.id ?? interaction.channelId,
                            );
                            const permissions = channel.permissionsFor(ctx.client.user!);
                            if (reference && !permissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
                                throw new UserError(
                                    "Для редактирования боту нужно право «Читать историю сообщений».",
                                );
                            }
                            if (media && !permissions?.has(PermissionFlagsBits.AttachFiles)) {
                                throw new UserError(
                                    "Для отправки медиа боту нужно право «Прикреплять файлы».",
                                );
                            }
                        }
                        let original: Message | undefined;
                        if (reference) {
                            original = await channel.messages.fetch(reference.messageId);
                            if (original.author.id !== ctx.client.user?.id) {
                                throw new UserError("Бот может редактировать только собственные сообщения.");
                            }
                        }
                        const limit = uploadLimit(
                            interaction.attachmentSizeLimit,
                            channel.type === ChannelType.DM ? 0 : channel.guild.premiumTier,
                        );
                        const file = media ? await downloadMedia(media, limit, ctx.signal) : undefined;
                        ctx.signal.throwIfAborted();
                        const body = {
                            ...(content !== undefined ? { content } : {}),
                            ...(file ? { files: [file] } : {}),
                            allowedMentions: { parse: [] as [] },
                        };
                        const previousContent = original?.content;
                        const message = original
                            ? await original.edit({ ...body, ...(file ? { attachments: [] } : {}) })
                            : await channel.send({ ...body, nonce: interaction.id, enforceNonce: true });
                        ctx.log.info(original ? "Message edited" : "Message sent", {
                            actorId: interaction.user.id,
                            channelId: channel.id,
                            recipientId: user?.id,
                            messageId: message.id,
                            length: content?.length ?? 0,
                            attachments: file ? 1 : 0,
                        });
                        try {
                            await ctx.audit?.message({
                                action: original ? "edited" : "sent",
                                actorId: interaction.user.id,
                                channelId: channel.id,
                                messageId: message.id,
                                recipientId:
                                    user?.id ??
                                    (channel.type === ChannelType.DM
                                        ? (channel.recipient?.id ?? channel.recipientId)
                                        : undefined),
                                content: message.content ?? content ?? previousContent ?? "",
                                previousContent,
                                attachments: Array.from(
                                    message.attachments?.values() ?? original?.attachments?.values() ?? [],
                                ).map(({ name, url }) => ({ name, url })),
                                source: "say",
                            });
                        } catch (error) {
                            ctx.log.warn("Could not record message audit", {
                                channelId: channel.id,
                                messageId: message.id,
                                error,
                            });
                        }
                        await interaction.editReply(
                            `${original ? "Сообщение изменено" : "Сообщение отправлено"}: ${message.url}`,
                        );
                    } catch (error) {
                        throw friendlyDiscordError(error);
                    } finally {
                        if (media) mediaBusy = false;
                    }
                },
            },
        ],
    };
}
