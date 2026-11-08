import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
    ApplicationCommandType,
    ChannelType,
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    type Interaction,
    type ClientEvents,
    type ModalBuilder,
} from "discord.js";
import type { Config } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";
import { createClient, fatalLoginError, runBot } from "../src/runtime.ts";
import { Store } from "../src/store.ts";

const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    for (const stop of cleanup.splice(0).toReversed()) await stop();
});

function fixtures() {
    const controller = new AbortController();
    const store = new Store(":memory:");
    const log = {
        info: mock((_message: string, _data?: Record<string, unknown>) => {}),
        warn: mock((_message: string, _data?: Record<string, unknown>) => {}),
        error: mock((_message: string, _data?: Record<string, unknown>) => {}),
    };
    const config: Config = {
        botToken: "test-token",
        serverId: "123456789012345678",
        modRoleId: "223456789012345678",
        kumaPushUrl: "https://status.example.test/api/push/test",
        stickyHeader: "Header",
        stickyFooter: "Footer",
        userAgent: "Test/1.0",
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const getState = spyOn(store, "getState");
    const listSticky = spyOn(store, "listSticky");
    const destroyed: Client[] = [];
    const destroy = Client.prototype.destroy;
    const destroySpy = spyOn(Client.prototype, "destroy").mockImplementation(async function (this: Client) {
        destroyed.push(this);
        await destroy.call(this);
    });
    const run = () => runBot(config, log as unknown as Logger, store, controller.signal);
    cleanup.push(() => {
        controller.abort();
        fetchSpy.mockRestore();
        getState.mockRestore();
        listSticky.mockRestore();
        destroySpy.mockRestore();
        store.close();
    });
    return { controller, config, store, log, fetchSpy, getState, listSticky, destroyed, run };
}

function queuedAuditText(store: Store): string {
    return store
        .pendingAudit()
        .map((row) => {
            const payload = JSON.parse(row.payload) as {
                content?: string;
                embeds?: { description?: string }[];
            };
            return (
                payload.content ?? payload.embeds?.map((embed) => embed.description ?? "").join("\n") ?? ""
            );
        })
        .join("\n");
}

describe("Discord runtime", () => {
    test("requests only the intents needed for slash commands, stickies and DMs", async () => {
        const client = createClient();
        try {
            expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
            expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
            expect(client.options.intents.has(GatewayIntentBits.DirectMessages)).toBe(true);
            expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false);
            expect(client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(false);
            expect(client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(false);
            expect(client.options.allowedMentions?.parse).toEqual([]);
        } finally {
            await client.destroy();
        }
    });

    test("shutdown aborts an in-flight native REST request without another network attempt", async () => {
        const controller = new AbortController();
        const client = createClient(controller.signal);
        client.rest.setToken("test");
        const started = Promise.withResolvers<AbortSignal>();
        const fakeFetch = Object.assign(
            async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
                const signal = init?.signal;
                if (!signal) throw new Error("REST request did not supply an abort signal");
                started.resolve(signal);
                return await new Promise<Response>((_resolve, reject) => {
                    if (signal.aborted) reject(signal.reason);
                    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            },
            { preconnect: fetch.preconnect },
        );
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
        const request = client.rest.get("/gateway/bot");
        const rejected = request.then(
            () => null,
            (error: unknown) => error,
        );

        try {
            const requestSignal = await started.promise;
            controller.abort();
            expect(await rejected).toBe(controller.signal.reason);
            expect(requestSignal.aborted).toBe(true);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            controller.abort();
            await rejected;
            fetchSpy.mockRestore();
            await client.destroy();
        }
    }, 1_000);

    test("an already-aborted REST session does not start a network request", async () => {
        const controller = new AbortController();
        controller.abort();
        const client = createClient(controller.signal);
        client.rest.setToken("test");
        const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
            new Error("Unexpected network request"),
        );

        try {
            await expect(client.rest.get("/gateway/bot")).rejects.toBe(controller.signal.reason);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
            await client.destroy();
        }
    }, 1_000);

    test("the native REST deadline remains active while reading a stalled response body", async () => {
        const controller = new AbortController();
        const deadline = new AbortController();
        const client = createClient(controller.signal);
        client.rest.setToken("test");
        const reading = Promise.withResolvers<AbortSignal>();
        const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        const fakeFetch = Object.assign(
            async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
                const signal = init?.signal;
                if (!signal) throw new Error("REST request did not supply an abort signal");
                const response = new Response(
                    new ReadableStream({
                        start(stream) {
                            if (signal.aborted) stream.error(signal.reason);
                            else
                                signal.addEventListener("abort", () => stream.error(signal.reason), {
                                    once: true,
                                });
                        },
                    }),
                    { headers: { "Content-Type": "application/json" } },
                );
                const readJSON = response.json.bind(response);
                response.json = async () => {
                    reading.resolve(signal);
                    return await readJSON();
                };
                return response;
            },
            { preconnect: fetch.preconnect },
        );
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
        let settled = false;
        const outcome = client.rest.get("/gateway/bot").then(
            () => {
                settled = true;
                return null;
            },
            (error: unknown) => {
                settled = true;
                return error;
            },
        );
        try {
            const requestSignal = await reading.promise;
            expect(timeoutSpy).toHaveBeenCalledWith(15_000);
            expect(settled).toBe(false);
            expect(requestSignal.aborted).toBe(false);
            const error = new DOMException("REST body timed out", "TimeoutError");
            deadline.abort(error);
            expect(await outcome).toBe(error);
            expect(requestSignal.aborted).toBe(true);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            controller.abort();
            await outcome;
            fetchSpy.mockRestore();
            timeoutSpy.mockRestore();
            await client.destroy();
        }
    }, 1_000);

    test("native REST responses are decoded through the real Discord REST client", async () => {
        const client = createClient();
        client.rest.setToken("test");
        const data = { url: "wss://gateway.example.test", shards: 1 };
        const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(data));

        try {
            expect(await client.rest.get("/gateway/bot")).toEqual(data);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://discord.com/api/v10/gateway/bot");
        } finally {
            fetchSpy.mockRestore();
            await client.destroy();
        }
    }, 1_000);

    test("native REST uploads a media file as valid multipart data", async () => {
        const originalFetch = globalThis.fetch;
        let received: FormData | undefined;
        const client = createClient();
        client.rest.setToken("test");
        const fakeFetch = Object.assign(
            async (_input: URL | RequestInfo, init?: RequestInit) => {
                received = await new Request("https://discord.example.test", init).formData();
                return Response.json({ id: "message" });
            },
            { preconnect: originalFetch.preconnect },
        );
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
        try {
            expect(
                await client.rest.post("/channels/123/messages", {
                    body: { content: "Media test" },
                    files: [{ data: Buffer.from("media bytes"), name: "clip.mp4", contentType: "video/mp4" }],
                }),
            ).toEqual({ id: "message" });
            const form = received!;
            expect(JSON.parse(String(form.get("payload_json")))).toEqual({ content: "Media test" });
            const file = form.get("files[0]") as File;
            expect(file.name).toBe("clip.mp4");
            expect(file.type).toBe("video/mp4");
            expect(await file.text()).toBe("media bytes");
        } finally {
            fetchSpy.mockRestore();
            await client.destroy();
        }
    }, 1_000);

    test("retries an initial network failure with a fresh Discord client", async () => {
        const { controller, log, fetchSpy, getState, listSticky, destroyed, run } = fixtures();
        const clients: Client[] = [];
        const loginSpy = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
            clients.push(this);
            if (clients.length === 1) throw Object.assign(new Error("Offline"), { code: "ENETUNREACH" });
            controller.abort();
            return "test-token";
        });
        cleanup.push(() => loginSpy.mockRestore());
        await run();
        expect(loginSpy).toHaveBeenCalledTimes(2);
        expect(clients[0]).not.toBe(clients[1]);
        expect(destroyed).toEqual(clients);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.info).not.toHaveBeenCalled();
        expect(getState).not.toHaveBeenCalled();
        expect(listSticky).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    }, 5_000);

    test("an invalid token fails once and cleans up instead of retrying forever", async () => {
        const { log, fetchSpy, getState, destroyed, run } = fixtures();
        const error = Object.assign(new Error("Invalid test token"), { code: "TokenInvalid" });
        const loginSpy = spyOn(Client.prototype, "login").mockRejectedValue(error);
        cleanup.push(() => loginSpy.mockRestore());
        await expect(run()).rejects.toBe(error);
        expect(loginSpy).toHaveBeenCalledTimes(1);
        expect(destroyed).toHaveLength(1);
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
        expect(getState).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("shutdown interrupts a stalled initial login promptly without starting plugins", async () => {
        const { controller, log, fetchSpy, getState, listSticky, destroyed, run } = fixtures();
        const started = Promise.withResolvers<void>();
        const loginSpy = spyOn(Client.prototype, "login").mockImplementation(async () => {
            started.resolve();
            return await new Promise<string>(() => {});
        });
        cleanup.push(() => loginSpy.mockRestore());
        const running = run();
        await started.promise;
        controller.abort();
        await running;
        expect(loginSpy).toHaveBeenCalledTimes(1);
        expect(destroyed).toHaveLength(1);
        expect(log.info).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
        expect(getState).not.toHaveBeenCalled();
        expect(listSticky).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    }, 1_000);

    test("a fatal gateway close after login stops the session and destroys its client", async () => {
        const { controller, log, fetchSpy, destroyed, run } = fixtures();
        const started = Promise.withResolvers<void>();
        let connectedClient!: Client;
        const fakeFetch = Object.assign(async () => Response.json(123), { preconnect: fetch.preconnect });
        fetchSpy.mockImplementation(fakeFetch);
        log.info.mockImplementation((message, data) => {
            if (message === "Plugin started" && data?.plugin === "events") started.resolve();
        });
        const loginSpy = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
            connectedClient = this;
            Object.defineProperty(this, "isReady", { value: () => true });
            Object.defineProperty(this, "user", { value: { tag: "Test#0000", setPresence: mock(() => {}) } });
            Object.defineProperty(this.guilds, "fetch", {
                value: async () => ({ id: "123456789012345678", commands: { set: async () => {} } }),
            });
            return "test-token";
        });
        cleanup.push(() => loginSpy.mockRestore());
        const running = run();
        const outcome = running.then(
            () => null,
            (error: unknown) => error,
        );
        cleanup.push(async () => {
            controller.abort();
            await outcome;
        });

        await started.promise;
        connectedClient.emit(
            Events.ShardDisconnect,
            { code: 4004, wasClean: false, reason: "Invalid authentication" },
            0,
        );
        expect(await outcome).toMatchObject({ message: "Discord session closed", code: 4004 });
        expect(loginSpy).toHaveBeenCalledTimes(1);
        expect(destroyed).toEqual([connectedClient]);
        expect(log.warn.mock.calls).toEqual([["Discord session closed", { code: 4004 }]]);
    }, 1_000);

    test("registers and routes the context editor and its modal while retaining slash media editing", async () => {
        const { controller, config, store, log, fetchSpy, run } = fixtures();
        config.auditThreadId = "1568864966919061514";
        const botId = "333333333333333333";
        const userId = "444444444444444444";
        const channelId = "555555555555555555";
        config.botChannelId = channelId;
        const messageId = "666666666666666666";
        const started = Promise.withResolvers<void>();
        const registered = Promise.withResolvers<unknown[]>();
        const shown = Promise.withResolvers<ModalBuilder>();
        const saved = Promise.withResolvers<void>();
        let client!: Client;
        const message = {
            id: messageId,
            channelId,
            author: { id: botId },
            content: "Original text",
            attachments: new Map([["media", { id: "media" }]]),
            embeds: [],
            components: [],
            stickers: new Map(),
            poll: null,
            edit: mock(async (_data: unknown) => ({ url: "https://discord.com/message" })),
        };
        const channel = {
            id: channelId,
            guildId: "123456789012345678",
            type: ChannelType.GuildText,
            permissionsFor: () => ({ has: () => true }),
            messages: { fetch: mock(async () => message) },
            send: mock(async (_payload: unknown) => ({ id: "startup" })),
        };
        fetchSpy.mockImplementation(
            Object.assign(async () => Response.json(123), { preconnect: fetch.preconnect }),
        );
        log.info.mockImplementation((text, data) => {
            if (text === "Plugin started" && data?.plugin === "events") started.resolve();
        });
        const loginSpy = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
            client = this;
            Object.defineProperty(this, "isReady", { value: () => true });
            Object.defineProperty(this, "user", {
                value: { id: botId, tag: "Test#0000", setPresence: mock(() => {}) },
            });
            Object.defineProperty(this.guilds, "fetch", {
                value: async () => ({
                    id: channel.guildId,
                    commands: {
                        set: async (data: unknown[]) => {
                            registered.resolve(data);
                        },
                    },
                }),
            });
            Object.defineProperty(this.channels, "fetch", { value: async () => channel });
            return "test-token";
        });
        cleanup.push(() => loginSpy.mockRestore());
        const running = run();
        cleanup.push(async () => {
            controller.abort();
            await running;
        });
        const [, data] = await Promise.all([started.promise, registered.promise]);
        expect(data).toContainEqual(
            expect.objectContaining({
                type: ApplicationCommandType.Message,
                name: "Редактировать сообщение бота",
            }),
        );
        expect(data).toContainEqual(
            expect.objectContaining({
                name: "say",
                options: expect.arrayContaining([expect.objectContaining({ name: "media" })]),
            }),
        );
        const shared = {
            guildId: channel.guildId,
            channelId,
            user: { id: userId },
            memberPermissions: { has: () => false },
            member: { roles: { cache: { has: () => true } } },
            inCachedGuild: () => true,
            replied: false,
            deferred: false,
            reply: mock(async () => {}),
        };
        const context = {
            ...shared,
            isChatInputCommand: () => false,
            isMessageContextMenuCommand: () => true,
            commandName: "Редактировать сообщение бота",
            targetMessage: message,
            targetId: messageId,
            deferReply: mock(async () => {}),
            showModal: mock(async (modal: ModalBuilder) => {
                shown.resolve(modal);
            }),
        };
        client.emit(Events.InteractionCreate, context as unknown as Interaction);
        const modal = await shown.promise;
        expect(context.deferReply).not.toHaveBeenCalled();
        const submission = {
            ...shared,
            isChatInputCommand: () => false,
            isMessageContextMenuCommand: () => false,
            isModalSubmit: () => true,
            customId: modal.toJSON().custom_id,
            fields: { getTextInputValue: () => "Updated text" },
            deferReply: mock(async () => {
                submission.deferred = true;
            }),
            editReply: mock(async () => {
                saved.resolve();
            }),
        };
        client.emit(Events.InteractionCreate, submission as unknown as Interaction);
        await saved.promise;
        expect(submission.deferReply).toHaveBeenCalledWith({ flags: 64 });
        expect(message.edit).toHaveBeenCalledWith({
            content: "Updated text",
            allowedMentions: { parse: [] },
        });
        expect(message.attachments.size).toBe(1);
        const audit = queuedAuditText(store);
        expect(audit).toContain(`<@${userId}> → <#${channelId}>`);
        expect(audit).toContain("Original text");
        expect(audit).toContain("Updated text");
        expect(channel.send).toHaveBeenCalledWith({ content: "vrcru-general-bot перезагружен" });
        controller.abort();
        await running;
    }, 1_000);

    test("routes human DMs to durable audit and excludes banner uploads even if banner update fails", async () => {
        const { controller, config, store, log, fetchSpy, run } = fixtures();
        config.auditThreadId = "1568864966919061514";
        config.weeklyImageHostId = "777777777777777777";
        const started = Promise.withResolvers<void>();
        let client!: Client;
        fetchSpy.mockImplementation(
            Object.assign(async () => Response.json(123), { preconnect: fetch.preconnect }),
        );
        log.info.mockImplementation((message, data) => {
            if (message === "Plugin started" && data?.plugin === "events") started.resolve();
        });
        const loginSpy = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
            client = this;
            Object.defineProperty(this, "isReady", { value: () => true });
            Object.defineProperty(this, "user", {
                value: { id: "bot", tag: "Test#0000", setPresence: mock(() => {}) },
            });
            Object.defineProperty(this.guilds, "fetch", {
                value: async () => ({
                    id: config.serverId,
                    features: [],
                    commands: { set: async () => {} },
                }),
            });
            return "test-token";
        });
        cleanup.push(() => loginSpy.mockRestore());
        const running = run();
        cleanup.push(async () => {
            controller.abort();
            await running;
        });
        await started.promise;
        const dm = {
            id: "444444444444444444",
            channelId: "555555555555555555",
            guildId: null,
            author: { id: "666666666666666666", bot: false },
            content: "A human DM @everyone",
            attachments: new Map(),
            createdTimestamp: Date.now(),
        };
        const banner = {
            ...dm,
            id: "888888888888888888",
            author: { id: config.weeklyImageHostId, bot: false },
            content: "Banner caption that must stay excluded",
            attachments: new Collection([
                [
                    "banner",
                    {
                        name: "image.png",
                        size: 9,
                        contentType: "image/png",
                        url: "https://cdn.discordapp.com/attachments/1/2/image.png",
                    },
                ],
            ]),
            reply: mock(async () => {}),
        };
        client.emit(Events.MessageCreate, dm as unknown as ClientEvents["messageCreate"][0]);
        client.emit(Events.MessageCreate, banner as unknown as ClientEvents["messageCreate"][0]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const audit = queuedAuditText(store);
        expect(audit).toContain("A human DM @everyone");
        expect(audit).toContain(`<@${dm.author.id}>`);
        expect(audit).not.toContain("Banner caption");
        expect(store.pendingAudit()).toHaveLength(1);
        expect(banner.reply).toHaveBeenCalledTimes(1);
        expect(log.error).not.toHaveBeenCalled();
        controller.abort();
        await running;
    }, 1_000);

    test("fatal gateway and credential errors are distinguished from temporary network errors", () => {
        for (const code of ["TokenInvalid", "DisallowedIntents", "InvalidIntents", 4004, 4013, 4014]) {
            expect(fatalLoginError({ code })).toBe(true);
        }
        for (const error of [{ code: "ECONNRESET" }, { code: 500 }, new Error("Offline"), null]) {
            expect(fatalLoginError(error)).toBe(false);
        }
    });
});
