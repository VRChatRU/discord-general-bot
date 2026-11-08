import type { Attachment, AttachmentPayload } from "discord.js";
import { UserError } from "./discord.ts";

export const MAX_MEDIA_BYTES = 100 * 1_024 * 1_024;
const DEFAULT_MEDIA_BYTES = 20 * 1_024 * 1_024;
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function mediaLimit(interactionLimit: number): number {
    return Number.isSafeInteger(interactionLimit) && interactionLimit > 0
        ? Math.min(interactionLimit, MAX_MEDIA_BYTES)
        : DEFAULT_MEDIA_BYTES;
}

export function uploadLimit(interactionLimit: number, premiumTier = 0): number {
    const destinationLimit =
        premiumTier >= 3 ? MAX_MEDIA_BYTES : premiumTier >= 2 ? 50 * 1_024 * 1_024 : DEFAULT_MEDIA_BYTES;
    return Math.min(mediaLimit(interactionLimit), destinationLimit);
}

export async function downloadMedia(
    attachment: Pick<Attachment, "url" | "size" | "name">,
    limit: number,
    signal: AbortSignal,
): Promise<AttachmentPayload> {
    signal.throwIfAborted();
    const maxBytes = mediaLimit(limit);
    const tooLarge = () =>
        new UserError(`Размер медиа не должен превышать ${Math.floor(maxBytes / 1_024 / 1_024)} МиБ.`);
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > maxBytes) {
        throw tooLarge();
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
        url.port ||
        !/^\/(?:ephemeral-)?attachments\//.test(url.pathname)
    ) {
        throw new UserError("Прикрепи медиа к slash-команде Discord.");
    }
    const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
    });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new UserError("Не удалось скачать медиа. Прикрепи файл заново.");
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body.cancel();
        throw tooLarge();
    }
    const buffer = Buffer.allocUnsafe(attachment.size);
    const reader = response.body.getReader();
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.byteLength > buffer.length) {
                await reader.cancel();
                throw new UserError("Размер вложения изменился. Прикрепи файл заново.");
            }
            buffer.set(value, size);
            size += value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    if (size !== buffer.length) throw new UserError("Файл загружен не полностью. Прикрепи его заново.");
    signal.throwIfAborted();
    return {
        attachment: buffer,
        name: (attachment.name || "attachment").replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 200),
    };
}
