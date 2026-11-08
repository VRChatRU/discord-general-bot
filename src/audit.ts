import { escapeMarkdown, type APIEmbed, type Message } from "discord.js";
import { EMBED_COLOR } from "./style.ts";
import type { PluginContext } from "./types.ts";

export interface MessageAuditEvent {
    action: "sent" | "edited";
    actorId: string;
    channelId: string;
    messageId: string;
    recipientId?: string;
    content?: string;
    previousContent?: string;
    attachments?: { name: string; url: string }[];
    source?: string;
}

const MAX_DESCRIPTION = 3_800;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function splitDescription(description: string): string[] {
    const parts: string[] = [];
    while (description.length > MAX_DESCRIPTION) {
        let end = description.lastIndexOf("\n\n", MAX_DESCRIPTION - 2) + 2;
        if (end < MAX_DESCRIPTION / 2) end = description.lastIndexOf("\n", MAX_DESCRIPTION - 1) + 1;
        if (end < MAX_DESCRIPTION / 2) {
            end = 0;
            for (const part of segmenter.segment(description)) {
                const boundary = part.index + part.segment.length;
                if (boundary > MAX_DESCRIPTION) break;
                end = boundary;
            }
            if (!end) {
                end = MAX_DESCRIPTION;
                const code = description.charCodeAt(end - 1);
                if (code >= 0xd800 && code <= 0xdbff) end--;
            }
        }
        parts.push(description.slice(0, end));
        description = description.slice(end);
    }
    if (description) parts.push(description);
    return parts;
}

const quote = (content: string | undefined) => `> ${(content || "(без текста)").replaceAll("\n", "\n> ")}`;
const files = (attachments: { name: string; url: string }[] = []) =>
    attachments.map((file) => `[${escapeMarkdown(file.name || "Файл")}](${file.url})`).join("\n");

export class AuditRecorder {
    constructor(private readonly ctx: Pick<PluginContext, "config" | "store" | "log">) {}

    private record(title: string, description: string, url: string, timestamp: number): void {
        if (!this.ctx.config.auditThreadId) return;
        try {
            const parts = splitDescription(description);
            const time = new Date(timestamp).toISOString();
            this.ctx.store.enqueueAudit(
                parts.map((part, index) => {
                    const embed: APIEmbed = {
                        title: parts.length > 1 ? `${title} (${index + 1}/${parts.length})` : title,
                        url,
                        description: part,
                        color: EMBED_COLOR,
                        timestamp: time,
                    };
                    return JSON.stringify({ embeds: [embed] });
                }),
            );
        } catch (error) {
            this.ctx.log.error("Could not persist Discord audit event", { error });
        }
    }

    message(event: MessageAuditEvent): void {
        try {
            const destination = event.recipientId ? `ЛС <@${event.recipientId}>` : `<#${event.channelId}>`;
            const guildId = event.recipientId ? "@me" : this.ctx.config.serverId;
            const link = `https://discord.com/channels/${guildId}/${event.channelId}/${event.messageId}`;
            const text =
                event.action === "edited" && event.previousContent !== undefined
                    ? `**До**\n${quote(event.previousContent)}\n\n**После**\n${quote(event.content)}`
                    : quote(event.content);
            const description = [`<@${event.actorId}> → ${destination}`, text, files(event.attachments)]
                .filter(Boolean)
                .join("\n\n");
            this.record(
                event.action === "sent" ? "Сообщение отправлено" : "Сообщение изменено",
                description,
                link,
                Date.now(),
            );
        } catch (error) {
            this.ctx.log.error("Could not format message audit event", { error });
        }
    }

    dm(message: Message): void {
        try {
            const attachments = [...message.attachments.values()].map((file) => ({
                name: file.name,
                url: file.url,
            }));
            const description = [`<@${message.author.id}>`, quote(message.content), files(attachments)]
                .filter(Boolean)
                .join("\n\n");
            const link = message.url ?? `https://discord.com/channels/@me/${message.channelId}/${message.id}`;
            this.record("Входящее ЛС", description, link, message.createdTimestamp);
        } catch (error) {
            this.ctx.log.error("Could not format DM audit event", { error });
        }
    }
}
