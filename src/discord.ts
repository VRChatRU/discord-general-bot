import {
    ChannelType,
    PermissionFlagsBits,
    type AnyThreadChannel,
    type NewsChannel,
    type TextChannel,
} from "discord.js";
import type { PluginContext } from "./types.ts";

export class UserError extends Error {}

export function discordErrorCode(error: unknown): number | string | undefined {
    if (error && typeof error === "object" && "code" in error) {
        const code: unknown = error.code;
        if (typeof code === "number" || typeof code === "string") return code;
    }
    return undefined;
}

export async function getTextChannel(
    ctx: PluginContext,
    channelId: string,
    embed?: boolean,
): Promise<TextChannel | NewsChannel>;
export async function getTextChannel(
    ctx: PluginContext,
    channelId: string,
    embed: boolean,
    allowThreads: true,
): Promise<TextChannel | NewsChannel | AnyThreadChannel>;
export async function getTextChannel(
    ctx: PluginContext,
    channelId: string,
    embed = false,
    allowThreads = false,
): Promise<TextChannel | NewsChannel | AnyThreadChannel> {
    ctx.signal.throwIfAborted();
    const channel = await ctx.client.channels.fetch(channelId);
    if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement &&
            !(allowThreads && channel.isThread())) ||
        channel.guildId !== ctx.config.serverId
    ) {
        throw new UserError("Выберите текстовый канал этого сервера.");
    }
    const permissions = channel.permissionsFor(ctx.client.user!);
    const thread = channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement;
    const required = [
        PermissionFlagsBits.ViewChannel,
        thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
    ];
    if (embed) required.push(PermissionFlagsBits.EmbedLinks);
    if (!permissions?.has(required)) {
        throw new UserError(
            "Боту нужны права просмотра канала и отправки сообщений" +
                (thread ? " в ветках" : "") +
                (embed ? " и встроенных ссылок." : "."),
        );
    }
    return channel;
}
