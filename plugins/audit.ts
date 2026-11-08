import { PermissionFlagsBits, type APIEmbed, type MessageCreateOptions } from "discord.js";
import { startPeriodicTask } from "../src/tasks.ts";
import { EMBED_COLOR } from "../src/style.ts";
import type { Plugin, PluginContext } from "../src/types.ts";

function readPayload(payload: string): Pick<MessageCreateOptions, "content" | "embeds"> {
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === "object" && "embeds" in value) {
        if (!Array.isArray(value.embeds) || value.embeds.length !== 1)
            throw new Error("Invalid queued audit embed");
        const embed: unknown = value.embeds[0];
        if (
            !embed ||
            typeof embed !== "object" ||
            !("title" in embed) ||
            typeof embed.title !== "string" ||
            !embed.title ||
            embed.title.length > 256 ||
            !("description" in embed) ||
            typeof embed.description !== "string" ||
            !embed.description ||
            embed.description.length > 4_096
        ) {
            throw new Error("Invalid queued audit embed");
        }
        const result: APIEmbed = { title: embed.title, description: embed.description, color: EMBED_COLOR };
        if ("url" in embed && embed.url !== undefined) {
            if (typeof embed.url !== "string" || embed.url.length > 2_048)
                throw new Error("Invalid audit message link");
            const url = new URL(embed.url);
            if (
                url.protocol !== "https:" ||
                url.hostname !== "discord.com" ||
                url.username ||
                url.password ||
                url.port
            ) {
                throw new Error("Invalid audit message link");
            }
            result.url = embed.url;
        }
        if ("timestamp" in embed && embed.timestamp !== undefined) {
            if (typeof embed.timestamp !== "string" || !Number.isFinite(Date.parse(embed.timestamp))) {
                throw new Error("Invalid audit timestamp");
            }
            result.timestamp = new Date(embed.timestamp).toISOString();
        }
        return { embeds: [result] };
    }
    if (
        !value ||
        typeof value !== "object" ||
        !("content" in value) ||
        typeof value.content !== "string" ||
        !value.content ||
        value.content.length > 2_000
    ) {
        throw new Error("Invalid queued audit message");
    }
    // Pending logs written by older versions must remain deliverable.
    return { content: value.content };
}

export function createAuditPlugin(ctx: PluginContext, schedule = startPeriodicTask): Plugin {
    let stop: (() => void) | undefined;
    let running: Promise<void> | undefined;

    const flush = (): Promise<void> => {
        if (running) return running;
        running = (async () => {
            if (ctx.signal.aborted || !ctx.client.isReady() || !ctx.config.auditThreadId) return;
            const rows = ctx.store.pendingAudit(10);
            if (!rows.length) return;
            const thread = await ctx.client.channels.fetch(ctx.config.auditThreadId);
            ctx.signal.throwIfAborted();
            if (!thread?.isThread() || thread.guildId !== ctx.config.serverId) {
                throw new Error("AUDIT_THREAD_ID must refer to a thread in the configured server");
            }
            const permissions = thread.permissionsFor(ctx.client.user!);
            if (
                !permissions?.has([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessagesInThreads,
                ])
            ) {
                throw new Error(
                    "Audit thread requires View Channel and Send Messages in Threads permissions",
                );
            }
            if (thread.archived && thread.locked) throw new Error("Audit thread is archived and locked");
            for (const row of rows) {
                ctx.signal.throwIfAborted();
                if (!/^[A-Za-z0-9_-]{1,25}$/.test(row.id)) throw new Error("Invalid queued audit nonce");
                const payload = readPayload(row.payload);
                if (payload.embeds && !permissions.has(PermissionFlagsBits.EmbedLinks)) {
                    throw new Error("Audit thread requires Embed Links permission");
                }
                const message = await thread.send({
                    ...payload,
                    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
                    nonce: row.id,
                    enforceNonce: true,
                });
                // Keep acknowledged deliveries committed even if shutdown starts during send.
                ctx.store.removeAudit(row.id);
                ctx.log.info("Delivered audit event", {
                    auditId: row.id,
                    threadId: thread.id,
                    messageId: message.id,
                });
            }
        })();
        const current = running;
        void current.then(
            () => {
                running = undefined;
            },
            () => {
                running = undefined;
            },
        );
        return current;
    };

    return {
        name: "audit",
        start() {
            if (!ctx.config.auditThreadId) {
                ctx.log.info("Audit logging is disabled");
                return;
            }
            stop = schedule(ctx, "Audit delivery", flush, { intervalMs: 15_000 });
        },
        onMessage(message) {
            if (ctx.signal.aborted || !ctx.config.auditThreadId || message.guildId || message.author.bot)
                return;
            if (message.author.id === ctx.config.weeklyImageHostId && message.attachments.size > 0) return;
            ctx.audit?.dm(message);
        },
        stop() {
            stop?.();
        },
    };
}
