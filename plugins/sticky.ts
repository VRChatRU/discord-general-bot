import { ChannelType, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordErrorCode, getTextChannel, UserError } from "../src/discord.ts";
import { startPeriodicTask } from "../src/tasks.ts";
import { EMBED_COLOR } from "../src/style.ts";
import type { Plugin, PluginContext } from "../src/types.ts";

export function createStickyPlugin(
    ctx: PluginContext,
    { delayMs = 10_000, repairIntervalMs = 60_000 } = {},
): Plugin {
    const queues = new Map<string, Promise<void>>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const failures = new Set<string>();
    let stopTask: (() => void) | undefined;

    const serialize = (channelId: string, task: () => Promise<void>) => {
        const previous = queues.get(channelId) ?? Promise.resolve();
        const pending = previous
            .catch(() => {})
            .then(async () => {
                ctx.signal.throwIfAborted();
                await task();
            });
        queues.set(channelId, pending);
        ctx.pending?.add(pending);
        const cleanup = () => {
            if (queues.get(channelId) === pending) queues.delete(channelId);
            ctx.pending?.delete(pending);
        };
        void pending.then(cleanup, cleanup);
        return pending;
    };

    const report = (channelId: string, error: unknown) => {
        if (!ctx.signal.aborted && !failures.has(channelId)) {
            failures.add(channelId);
            ctx.log.warn("Sticky update failed; will retry", { channelId, error });
        }
    };

    const refresh = async (channelId: string) => {
        let sticky = ctx.store.getSticky(channelId);
        if (!sticky || (!sticky.dirty && !sticky.retiring && sticky.messageId)) return;
        const channel = await getTextChannel(ctx, channelId, !sticky.retiring);
        if (sticky.messageId) {
            try {
                await channel.messages.delete(sticky.messageId);
            } catch (error) {
                if (discordErrorCode(error) !== 10008) throw error;
            }
            ctx.signal.throwIfAborted();
            ctx.store.clearStickyMessage(channelId);
        }
        if (sticky.retiring) {
            ctx.store.removeSticky(channelId);
            ctx.log.info("Removed sticky message", { channelId });
        } else {
            sticky = ctx.store.getSticky(channelId)!;
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(ctx.config.stickyHeader)
                .setDescription(sticky.content)
                .setFooter({ text: ctx.config.stickyFooter, iconURL: ctx.config.stickyIconUrl });
            ctx.signal.throwIfAborted();
            ctx.store.beginStickySend(channelId);
            try {
                const message = await channel.send({
                    embeds: [embed],
                    allowedMentions: { parse: [] },
                    nonce: sticky.nonce,
                    enforceNonce: true,
                });
                ctx.store.setStickyMessage(channelId, message.id);
                ctx.signal.throwIfAborted();
                // A repeated nonce can return an earlier accepted version after a lost response.
                const actual = message.embeds[0];
                const expected = embed.data;
                if (
                    message.embeds.length !== 1 ||
                    actual?.title !== expected.title ||
                    actual?.description !== expected.description ||
                    actual?.color !== expected.color ||
                    actual?.footer?.text !== expected.footer?.text ||
                    actual?.footer?.iconURL !== expected.footer?.icon_url
                ) {
                    await message.edit({ embeds: [embed], allowedMentions: { parse: [] } });
                }
                ctx.log.info("Published sticky message", { channelId, messageId: message.id });
            } catch (error) {
                ctx.store.markStickyDirty(channelId);
                throw error;
            }
        }
        if (failures.delete(channelId)) ctx.log.info("Sticky update recovered", { channelId });
    };

    const cancelTimer = (channelId: string) => {
        const timer = timers.get(channelId);
        if (timer) clearTimeout(timer);
        timers.delete(channelId);
    };

    const stick = new SlashCommandBuilder()
        .setName("stick")
        .setDescription("Создать или заменить липкое сообщение")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("Канал")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("text")
                .setDescription("Текст сообщения")
                .setMinLength(1)
                .setMaxLength(4_000)
                .setRequired(true),
        );
    const delstick = new SlashCommandBuilder()
        .setName("delstick")
        .setDescription("Удалить липкое сообщение")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("Канал")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true),
        );

    return {
        name: "sticky",
        commands: [
            {
                data: stick.toJSON(),
                async execute(interaction) {
                    const channelId = interaction.options.getChannel("channel", true).id;
                    const content = interaction.options.getString("text", true).trim();
                    if (!content) {
                        await interaction.editReply("Текст не должен быть пустым.");
                        return;
                    }
                    if (
                        content.length + ctx.config.stickyHeader.length + ctx.config.stickyFooter.length >
                        6_000
                    ) {
                        throw new UserError(
                            "Текст вместе с заголовком и подписью не должен превышать 6000 символов.",
                        );
                    }
                    await getTextChannel(ctx, channelId, true);
                    cancelTimer(channelId);
                    let published = false;
                    await serialize(channelId, async () => {
                        ctx.store.setSticky(channelId, content);
                        ctx.log.info("Saved sticky message", { channelId, userId: interaction.user.id });
                        try {
                            await refresh(channelId);
                            published = true;
                        } catch (error) {
                            report(channelId, error);
                        }
                    });
                    await interaction.editReply(
                        published
                            ? `Липкое сообщение установлено в <#${channelId}>.`
                            : "Сообщение сохранено. Публикация временно недоступна; бот повторит попытку автоматически.",
                    );
                },
            },
            {
                data: delstick.toJSON(),
                async execute(interaction) {
                    const channelId = interaction.options.getChannel("channel", true).id;
                    cancelTimer(channelId);
                    let found = false;
                    let removed = false;
                    await serialize(channelId, async () => {
                        if (!ctx.store.getSticky(channelId)) return;
                        found = true;
                        ctx.store.retireSticky(channelId);
                        ctx.log.info("Disabled sticky message", { channelId, userId: interaction.user.id });
                        try {
                            await refresh(channelId);
                            removed = true;
                        } catch (error) {
                            report(channelId, error);
                        }
                    });
                    await interaction.editReply(
                        !found
                            ? "В этом канале нет липкого сообщения."
                            : removed
                              ? "Липкое сообщение удалено."
                              : "Обновление отключено. Бот удалит старое сообщение, когда доступ восстановится.",
                    );
                },
            },
        ],
        start() {
            stopTask = startPeriodicTask(
                ctx,
                "Sticky repair",
                async () => {
                    if (!ctx.client.isReady()) return;
                    const dirty = ctx.store
                        .listSticky()
                        .filter((sticky) => sticky.dirty || sticky.retiring || !sticky.messageId);
                    await Promise.all(
                        dirty.map((sticky) => {
                            if (queues.has(sticky.channelId) || timers.has(sticky.channelId)) return;
                            return serialize(sticky.channelId, () => refresh(sticky.channelId)).catch(
                                (error) => report(sticky.channelId, error),
                            );
                        }),
                    );
                },
                { intervalMs: repairIntervalMs },
            );
        },
        onMessage(message) {
            if (
                ctx.signal.aborted ||
                message.guildId !== ctx.config.serverId ||
                message.author.bot ||
                message.system
            )
                return;
            const channelId = message.channelId;
            const sticky = ctx.store.getSticky(channelId);
            if (!sticky || sticky.retiring) return;
            ctx.store.markStickyDirty(channelId);
            if (timers.has(channelId) || failures.has(channelId)) return;
            timers.set(
                channelId,
                setTimeout(() => {
                    timers.delete(channelId);
                    if (ctx.signal.aborted || !ctx.client.isReady()) return;
                    void serialize(channelId, () => refresh(channelId)).catch((error) =>
                        report(channelId, error),
                    );
                }, delayMs),
            );
        },
        stop() {
            stopTask?.();
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        },
    };
}
