import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Message } from "discord.js";
import { createBannerPlugin, downloadBannerImage } from "../plugins/banner.ts";
import type { PluginContext } from "../src/types.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const attachment = {
    url: "https://cdn.discordapp.com/attachments/123/456/banner.png?ex=123&hm=456",
    contentType: "image/png",
    size: png.length,
};
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
});

describe("banner downloads", () => {
    test("rejects oversized metadata before requesting the image", async () => {
        fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
        await expect(
            downloadBannerImage(
                { ...attachment, size: 10 * 1_024 * 1_024 + 1 },
                new AbortController().signal,
            ),
        ).rejects.toThrow("10 МиБ");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("rejects URLs outside the Discord CDN", async () => {
        fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
        for (const url of [
            "http://cdn.discordapp.com/image.png",
            "https://cdn.discordapp.com.evil.test/image.png",
            "https://localhost/image.png",
            "https://user:password@cdn.discordapp.com/image.png",
        ]) {
            await expect(
                downloadBannerImage({ ...attachment, url }, new AbortController().signal),
            ).rejects.toThrow("Discord");
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("downloads images with cancellation and redirects disabled", async () => {
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(png, {
                headers: { "content-type": "image/png" },
            }),
        );
        const result = await downloadBannerImage(attachment, new AbortController().signal);
        expect(result.buffer).toEqual(png);
        expect(result.type).toBe("image/png");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
        expect(options.redirect).toBe("error");
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    test("rejects non-image bytes even when the content type claims PNG", async () => {
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("not an image", {
                headers: { "content-type": "image/png" },
            }),
        );
        await expect(downloadBannerImage(attachment, new AbortController().signal)).rejects.toThrow(
            "не является изображением",
        );
    });

    test("cancels a response whose declared size exceeds the limit", async () => {
        const cancel = mock(() => {});
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(new ReadableStream({ cancel }), {
                headers: { "content-type": "image/png", "content-length": "10485761" },
            }),
        );
        await expect(downloadBannerImage(attachment, new AbortController().signal)).rejects.toThrow("10 МиБ");
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    test("limits streamed bytes even without a content-length header", async () => {
        const cancel = mock(() => {});
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(10 * 1_024 * 1_024 + 1));
                    },
                    cancel,
                }),
                { headers: { "content-type": "image/png" } },
            ),
        );
        await expect(downloadBannerImage(attachment, new AbortController().signal)).rejects.toThrow("10 МиБ");
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    test("aborts a stalled HTTP response body", async () => {
        const stalledFetch = (async (_url: URL | RequestInfo, options?: RequestInit) => {
            const signal = options?.signal;
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(png);
                        signal?.addEventListener("abort", () => controller.error(signal.reason), {
                            once: true,
                        });
                    },
                }),
                { headers: { "content-type": "image/png" } },
            );
        }) as typeof fetch;
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation(stalledFetch);
        await expect(downloadBannerImage(attachment, AbortSignal.timeout(50))).rejects.toMatchObject({
            name: "TimeoutError",
        });
    });
});

describe("banner DMs", () => {
    function fixtures() {
        const guild = {
            id: "guild",
            features: ["BANNER"],
            members: { fetchMe: mock(async () => ({ permissions: { has: () => true } })) },
            setBanner: mock(async () => {}),
        };
        const log = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
        const ctx = {
            client: { guilds: { fetch: mock(async () => guild) } },
            config: { serverId: "guild", weeklyImageHostId: "host" },
            signal: new AbortController().signal,
            log,
        } as unknown as PluginContext;
        const message = {
            guildId: null,
            author: { id: "host", bot: false },
            attachments: { first: () => attachment },
            reply: mock(async () => {}),
            react: mock(async () => {}),
        };
        return { guild, log, plugin: createBannerPlugin(ctx), message };
    }

    test("exposes no slash commands", () => {
        expect(fixtures().plugin.commands ?? []).toHaveLength(0);
    });

    test("ignores DM attachments from other users", async () => {
        const { plugin, message, guild } = fixtures();
        message.author.id = "other-user";
        await plugin.onMessage?.(message as unknown as Message);
        expect(guild.members.fetchMe).not.toHaveBeenCalled();
        expect(message.reply).not.toHaveBeenCalled();
    });

    test("a download failure sends a friendly DM and does not escape", async () => {
        const { plugin, message, guild } = fixtures();
        fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network unavailable"));
        await plugin.onMessage?.(message as unknown as Message);
        expect(guild.setBanner).not.toHaveBeenCalled();
        expect(message.reply).toHaveBeenCalledTimes(1);
        expect(message.react).not.toHaveBeenCalled();
    });

    test("a failed success reaction does not report the banner update as failed", async () => {
        const { plugin, message, guild, log } = fixtures();
        fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(png, {
                headers: { "content-type": "image/png" },
            }),
        );
        message.react.mockRejectedValue(new Error("Message deleted"));
        await plugin.onMessage?.(message as unknown as Message);
        expect(guild.setBanner).toHaveBeenCalledTimes(1);
        expect(message.reply).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledTimes(1);
    });
});
