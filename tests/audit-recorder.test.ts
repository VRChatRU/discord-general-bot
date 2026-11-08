import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIEmbed, Message } from "discord.js";
import { AuditRecorder, type MessageAuditEvent } from "../src/audit.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { EMBED_COLOR } from "../src/style.ts";
import type { PluginContext } from "../src/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const stop of cleanup.splice(0)) stop();
});

function fixtures() {
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    const ctx = {
        config: { serverId: "111111111111111111", auditThreadId: "1568864966919061514" },
        store,
        log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    } as unknown as PluginContext;
    const recorder = new AuditRecorder(ctx);
    const event: MessageAuditEvent = {
        action: "sent",
        actorId: "222222222222222222",
        channelId: "333333333333333333",
        messageId: "444444444444444444",
        content: "Hello @everyone <@555555555555555555>",
    };
    const payloads = () =>
        store
            .pendingAudit(100)
            .map((row) => JSON.parse(row.payload) as { embeds: APIEmbed[]; content?: string });
    const embeds = () => payloads().map((payload) => payload.embeds[0]!);
    const content = () => embeds().map((embed) => embed.description!);
    return { store, ctx, recorder, event, content, embeds, payloads };
}

describe("audit formatting and durable outbox", () => {
    test("records one minimalist colored embed with actor, destination, linked title and native timestamp", () => {
        const { recorder, event, embeds, payloads, store } = fixtures();
        recorder.message(event);
        const embed = embeds()[0]!;
        expect(payloads()).toHaveLength(1);
        expect(payloads()[0]!.embeds).toHaveLength(1);
        expect(payloads()[0]).not.toHaveProperty("content");
        expect(embed.title).toBe("Сообщение отправлено");
        expect(embed.color).toBe(EMBED_COLOR);
        expect(embed.description).toBe(`<@${event.actorId}> → <#${event.channelId}>\n\n> ${event.content}`);
        expect(embed.url).toBe(
            `https://discord.com/channels/111111111111111111/${event.channelId}/${event.messageId}`,
        );
        expect(new Date(embed.timestamp!).toISOString()).toBe(embed.timestamp!);
        for (const redundant of ["Эли", "Кто:", "Куда:", "Время:", "ID сообщения:", "Текст:"]) {
            expect(JSON.stringify(embed)).not.toContain(redundant);
        }
        expect(embed).not.toHaveProperty("fields");
        expect(embed).not.toHaveProperty("footer");
        expect(store.pendingAudit()[0]!.id).toMatch(/^[a-f0-9]{25}$/);
    });

    test("DM destinations mention the recipient and use a DM message link", () => {
        const { recorder, event, content, embeds } = fixtures();
        event.recipientId = "555555555555555555";
        recorder.message(event);
        expect(content()[0]).toContain(`<@${event.actorId}> → ЛС <@${event.recipientId}>`);
        expect(embeds()[0]!.url).toBe(
            `https://discord.com/channels/@me/${event.channelId}/${event.messageId}`,
        );
    });

    test("edits retain before/after text and attachment links", () => {
        const { recorder, event, content, embeds } = fixtures();
        Object.assign(event, {
            action: "edited",
            previousContent: "Old text",
            content: "New text",
            attachments: [{ name: "clip.mp4", url: "https://cdn.discordapp.com/attachments/1/2/clip.mp4" }],
        });
        recorder.message(event);
        const text = content()[0]!;
        expect(embeds()[0]!.title).toBe("Сообщение изменено");
        expect(text).toContain("**До**\n> Old text\n\n**После**\n> New text");
        expect(text).toContain("clip.mp4");
        expect(text).toContain(event.attachments![0]!.url);
    });

    test("copies incoming DM text and file metadata without downloading files", () => {
        const { recorder, content, embeds } = fixtures();
        recorder.dm({
            id: "message",
            channelId: "channel",
            createdTimestamp: 1_000,
            author: { id: "author" },
            content: "A private message",
            attachments: new Map([
                ["file", { name: "photo.png", url: "https://cdn.discordapp.com/attachments/1/2/photo.png" }],
            ]),
        } as unknown as Message);
        const text = content()[0]!;
        expect(embeds()[0]!.title).toBe("Входящее ЛС");
        expect(embeds()[0]!.url).toBe("https://discord.com/channels/@me/channel/message");
        expect(embeds()[0]!.timestamp).toBe("1970-01-01T00:00:01.000Z");
        expect(embeds()[0]!.color).toBe(EMBED_COLOR);
        expect(text).toContain("<@author>");
        expect(text).toContain("A private message");
        expect(text).toContain("photo.png");
        expect(JSON.stringify(embeds()[0])).not.toContain("Эли");
    });

    test("long content is preserved in bounded chunks without broken emoji", () => {
        const { recorder, event, content, embeds, payloads } = fixtures();
        const longText = "😀".repeat(2_100) + "\nFinal line";
        event.content = longText;
        recorder.message(event);
        const parts = content();
        expect(parts.length).toBeGreaterThan(1);
        for (const [index, part] of parts.entries()) {
            expect(part.length).toBeLessThanOrEqual(3_800);
            expect(Buffer.from(part).toString()).toBe(part);
            const embed = embeds()[index]!;
            expect(embed.title).toBe(`Сообщение отправлено (${index + 1}/${parts.length})`);
            expect((embed.title?.length ?? 0) + part.length).toBeLessThanOrEqual(6_000);
            expect(embed.color).toBe(EMBED_COLOR);
            expect(payloads()[index]!.embeds).toHaveLength(1);
        }
        expect(parts.join("")).toBe(
            `<@${event.actorId}> → <#${event.channelId}>\n\n> ${longText.replaceAll("\n", "\n> ")}`,
        );
    });

    test("keeps complete joined emoji graphemes when a long line needs splitting", () => {
        const { recorder, event, content } = fixtures();
        const emoji = "👩🏽‍💻";
        event.content = emoji.repeat(1_200);
        recorder.message(event);
        const prefix = `<@${event.actorId}> → <#${event.channelId}>\n\n> `;
        const parts = content();
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.join("")).toBe(prefix + event.content);
        for (const [index, part] of parts.entries()) {
            const text = index === 0 ? part.slice(prefix.length) : part;
            expect(text.replaceAll(emoji, "")).toBe("");
            expect(part.length).toBeLessThanOrEqual(3_800);
        }
    });

    test("preserves every long attachment URL as a complete link across multiple embeds", () => {
        const { recorder, event, content } = fixtures();
        event.attachments = Array.from({ length: 10 }, (_, index) => ({
            name: `clip-${index}.mp4`,
            url: `https://cdn.discordapp.com/attachments/1/${index}/clip.mp4?hm=${"a".repeat(1_000)}`,
        }));
        recorder.message(event);
        const parts = content();
        expect(parts.length).toBeGreaterThan(1);
        for (const file of event.attachments)
            expect(parts.some((part) => part.includes(file.url))).toBe(true);
        expect(parts.every((part) => part.length <= 3_800)).toBe(true);
    });

    test("long before/after content survives splitting exactly without discarding either version", () => {
        const { recorder, event, content } = fixtures();
        event.action = "edited";
        event.previousContent = "До😀".repeat(1_200);
        event.content = "После💙".repeat(1_100);
        recorder.message(event);
        expect(content().join("")).toBe(
            `<@${event.actorId}> → <#${event.channelId}>\n\n**До**\n> ${event.previousContent}\n\n**После**\n> ${event.content}`,
        );
        expect(content().every((part) => part.length <= 3_800)).toBe(true);
        expect(content().every((part) => Buffer.from(part).toString() === part)).toBe(true);
    });

    test("a disabled audit destination queues nothing", () => {
        const { recorder, event, content, ctx } = fixtures();
        ctx.config.auditThreadId = undefined;
        recorder.message(event);
        expect(content()).toEqual([]);
    });

    test("persistence failures are logged without escaping a successful bot action", () => {
        const { recorder, event, ctx, store } = fixtures();
        const write = spyOn(store, "enqueueAudit").mockImplementation(() => {
            throw new Error("Disk full");
        });
        try {
            expect(() => recorder.message(event)).not.toThrow();
            expect(ctx.log.error).toHaveBeenCalledTimes(1);
        } finally {
            write.mockRestore();
        }
    });

    test("a chunk insertion failure rolls back the entire event and preserves earlier logs", () => {
        const { store } = fixtures();
        store.enqueueAudit([JSON.stringify({ content: "Earlier event" })]);
        const before = store.pendingAudit();
        expect(() =>
            store.enqueueAudit([JSON.stringify({ content: "First part" }), undefined as unknown as string]),
        ).toThrow();
        expect(store.pendingAudit()).toEqual(before);
    });

    test("queued events survive database reopening with their order and nonces", () => {
        const path = join(tmpdir(), `discord-general-bot-audit-${crypto.randomUUID()}.db`);
        let store = new Store(path);
        cleanup.push(() => {
            store.close();
            for (const suffix of ["", "-wal", "-shm"]) {
                try {
                    unlinkSync(path + suffix);
                } catch {}
            }
        });
        store.setSticky("channel", "Existing sticky");
        store.setState("existing-state", "unchanged");
        store.enqueueAudit([JSON.stringify({ content: "First" }), JSON.stringify({ content: "Second" })]);
        const before = store.pendingAudit();
        store.close();
        store = new Store(path);
        expect(store.pendingAudit()).toEqual(before);
        store.removeAudit(before[0]!.id);
        expect(store.pendingAudit()).toEqual([before[1]!]);
        expect(store.getSticky("channel")?.content).toBe("Existing sticky");
        expect(store.getState("existing-state")).toBe("unchanged");
    });

    test("audit thread configuration validates Discord IDs", () => {
        const env = {
            BOT_TOKEN: "test",
            SERVER_ID: "111111111111111111",
            MOD_ROLE_ID: "222222222222222222",
            KUMA_PUSH_URL: "https://status.example.test/push/test",
            AUDIT_THREAD_ID: "1568864966919061514",
        };
        expect(loadConfig(env).auditThreadId).toBe(env.AUDIT_THREAD_ID);
        expect(() => loadConfig({ ...env, AUDIT_THREAD_ID: "not-an-id" })).toThrow("AUDIT_THREAD_ID");
    });
});
