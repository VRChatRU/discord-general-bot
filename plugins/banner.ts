import { PermissionFlagsBits, type Attachment, type Message } from "discord.js";
import { UserError } from "../src/discord.ts";
import type { Plugin, PluginContext } from "../src/types.ts";

const MAX_IMAGE_BYTES = 10 * 1_024 * 1_024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type BannerAttachment = Pick<Attachment, "url" | "contentType" | "size">;

function imageType(buffer: Buffer): string | null {
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
    if (
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
    )
        return "image/webp";
    return null;
}

export async function downloadBannerImage(
    attachment: BannerAttachment,
    signal: AbortSignal,
): Promise<{ buffer: Buffer; type: string }> {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_IMAGE_BYTES) {
        throw new UserError("Размер изображения должен быть не больше 10 МиБ.");
    }
    if (attachment.contentType && !IMAGE_TYPES.has(attachment.contentType.toLowerCase())) {
        throw new UserError("Нужно изображение в формате PNG, JPEG, GIF или WebP.");
    }
    let url: URL;
    try {
        url = new URL(attachment.url);
    } catch {
        throw new UserError("Не удалось получить ссылку на вложение Discord.");
    }
    if (
        url.protocol !== "https:" ||
        !CDN_HOSTS.has(url.hostname) ||
        url.username ||
        url.password ||
        url.port
    ) {
        throw new UserError("Прикрепи изображение к сообщению Discord.");
    }
    const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: "error",
    });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new UserError("Не удалось скачать изображение. Отправь вложение ещё раз.");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    const declaredType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
    if (declaredLength > MAX_IMAGE_BYTES || (declaredType && !IMAGE_TYPES.has(declaredType))) {
        await response.body.cancel();
        throw new UserError("Нужно изображение PNG, JPEG, GIF или WebP размером до 10 МиБ.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_IMAGE_BYTES) {
                await reader.cancel();
                throw new UserError("Размер изображения должен быть не больше 10 МиБ.");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks, size);
    const type = imageType(buffer);
    if (!type) throw new UserError("Вложение не является изображением PNG, JPEG, GIF или WebP.");
    return { buffer, type };
}

export function createBannerPlugin(ctx: PluginContext): Plugin {
    let busy = false;

    async function updateBanner(attachment: BannerAttachment, actorId: string): Promise<void> {
        if (busy) throw new UserError("Баннер уже обновляется. Попробуй чуть позже.");
        busy = true;
        try {
            const guild = await ctx.client.guilds.fetch({ guild: ctx.config.serverId, force: true });
            if (!guild.features.includes("BANNER")) {
                throw new UserError("На сервере сейчас недоступна установка баннера.");
            }
            const bot = await guild.members.fetchMe();
            if (!bot.permissions.has(PermissionFlagsBits.ManageGuild)) {
                throw new UserError("Боту нужно право «Управлять сервером» для изменения баннера.");
            }
            const image = await downloadBannerImage(attachment, ctx.signal);
            if (image.type === "image/gif" && !guild.features.includes("ANIMATED_BANNER")) {
                throw new UserError("На сервере недоступен анимированный баннер. Пришли PNG, JPEG или WebP.");
            }
            ctx.signal.throwIfAborted();
            await guild.setBanner(image.buffer, `Banner updated by ${actorId}`);
            ctx.log.info("Guild banner updated", { actorId, guildId: guild.id, bytes: image.buffer.length });
        } finally {
            busy = false;
        }
    }

    async function replyToDM(message: Message, content: string): Promise<void> {
        try {
            await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
        } catch (error) {
            ctx.log.warn("Could not reply to banner DM", { userId: message.author.id, error });
        }
    }

    return {
        name: "banner",
        async onMessage(message) {
            if (message.guildId || message.author.bot || message.author.id !== ctx.config.weeklyImageHostId)
                return;
            const attachment = message.attachments.first();
            if (!attachment) return;
            try {
                await updateBanner(attachment, message.author.id);
            } catch (error) {
                if (ctx.signal.aborted) return;
                ctx.log.warn("Banner DM failed", { userId: message.author.id, error });
                await replyToDM(
                    message,
                    error instanceof UserError
                        ? error.message
                        : "Не удалось обновить баннер. Попробуй позже.",
                );
                return;
            }
            try {
                await message.react("✅");
            } catch (error) {
                ctx.log.warn("Could not acknowledge banner DM", { userId: message.author.id, error });
            }
        },
    };
}
