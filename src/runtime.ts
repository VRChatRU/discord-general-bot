import { setTimeout as delay } from "node:timers/promises";
import { Client, Events, GatewayIntentBits, Options, Partials, type ResponseLike } from "discord.js";
import { createBannerPlugin } from "../plugins/banner.ts";
import { createAuditPlugin } from "../plugins/audit.ts";
import { createEventsPlugin } from "../plugins/events.ts";
import { createEditMessagePlugin } from "../plugins/edit-message.ts";
import { createPlayerCountPlugin } from "../plugins/player-count.ts";
import { createSayPlugin } from "../plugins/say.ts";
import { createStickyPlugin } from "../plugins/sticky.ts";
import { handleCommand, handleMessageCommand, handleModal } from "./commands.ts";
import { discordErrorCode, getTextChannel } from "./discord.ts";
import { startKuma } from "./kuma.ts";
import { startPeriodicTask } from "./tasks.ts";
import { AuditRecorder } from "./audit.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "./store.ts";
import type { PluginContext } from "./types.ts";

const REST_TIMEOUT_MS = 15_000;

export function createClient(signal: AbortSignal = new AbortController().signal): Client {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
        allowedMentions: { parse: [] },
        makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
        rest: {
            timeout: REST_TIMEOUT_MS,
            retries: 2,
            rejectOnRateLimit: (limit) => limit.retryAfter > 15_000,
            makeRequest: async (url, init) => {
                signal.throwIfAborted();
                const response = await fetch(url, {
                    ...init,
                    signal: AbortSignal.any([
                        signal,
                        ...(init.signal ? [init.signal] : []),
                        AbortSignal.timeout(REST_TIMEOUT_MS),
                    ]),
                } as RequestInit);
                // REST accepts native fetch responses; its types use Node's stream definition.
                return response as unknown as ResponseLike;
            },
        },
    });
}

export function fatalLoginError(error: unknown): boolean {
    const code = discordErrorCode(error);
    return [
        "TokenInvalid",
        "DisallowedIntents",
        "InvalidIntents",
        4004,
        4010,
        4011,
        4012,
        4013,
        4014,
    ].includes(code ?? "");
}

export async function runBot(config: Config, log: Logger, store: Store, signal: AbortSignal): Promise<void> {
    let healthy = false;
    let attempt = 0;
    let announced = false;
    let activeClient: Client | undefined;
    const stopKuma = startKuma(config.kumaPushUrl, () => healthy && activeClient?.isReady() === true, signal);
    try {
        while (!signal.aborted) {
            const controller = new AbortController();
            const sessionSignal = AbortSignal.any([signal, controller.signal]);
            const client = createClient(sessionSignal);
            activeClient = client;
            const pending = new Set<Promise<unknown>>();
            const ctx: PluginContext = { client, config, log, store, signal: sessionSignal, pending };
            ctx.audit = new AuditRecorder(ctx);
            const plugins = [
                createStickyPlugin(ctx),
                createSayPlugin(ctx),
                createEditMessagePlugin(ctx),
                createAuditPlugin(ctx),
                createBannerPlugin(ctx),
                createPlayerCountPlugin(ctx),
                createEventsPlugin(ctx),
            ];
            const commands = new Map(
                plugins
                    .flatMap((plugin) => plugin.commands ?? [])
                    .map((command) => [command.data.name, command]),
            );
            const messageCommands = new Map(
                plugins
                    .flatMap((plugin) => plugin.messageCommands ?? [])
                    .map((command) => [command.data.name, command]),
            );
            const modals = plugins.flatMap((plugin) => plugin.modals ?? []);
            let registered = false;
            let disconnected = false;
            let stopRegistration: (() => void) | undefined;
            const track = (task: () => Promise<void>) => {
                const work = Promise.resolve()
                    .then(async () => {
                        if (!sessionSignal.aborted) await task();
                    })
                    .catch((error) => {
                        if (!sessionSignal.aborted) log.error("Event handler failed", { error });
                    });
                pending.add(work);
                void work.finally(() => pending.delete(work));
            };

            client.on(Events.Error, (error) => log.warn("Discord client error", { error }));
            client.on(Events.Warn, (message) => log.warn("Discord client warning", { detail: message }));
            client.on(Events.ShardError, (error) => {
                if (!disconnected) log.warn("Discord connection error; reconnecting", { error });
                disconnected = true;
                healthy = false;
            });
            client.on(Events.ShardDisconnect, (event) => {
                log.warn("Discord session closed", { code: event.code });
                disconnected = true;
                healthy = false;
                controller.abort(Object.assign(new Error("Discord session closed"), { code: event.code }));
            });
            client.on(Events.ShardReconnecting, (shardId) => {
                if (!disconnected) log.warn("Discord disconnected; reconnecting", { shardId });
                disconnected = true;
                healthy = false;
            });
            const connected = () => {
                if (disconnected) log.info("Discord connection restored");
                disconnected = false;
                healthy = registered && client.isReady();
            };
            client.on(Events.ShardResume, connected);
            client.on(Events.ClientReady, connected);
            client.on(Events.Invalidated, () => controller.abort(new Error("Discord session invalidated")));
            client.on(Events.InteractionCreate, (interaction) => {
                if (interaction.isChatInputCommand()) track(() => handleCommand(ctx, commands, interaction));
                else if (interaction.isMessageContextMenuCommand()) {
                    track(() => handleMessageCommand(ctx, messageCommands, interaction));
                } else if (interaction.isModalSubmit()) {
                    track(() => handleModal(ctx, modals, interaction));
                }
            });
            client.on(Events.MessageCreate, (message) => {
                if (sessionSignal.aborted || message.author.bot) return;
                for (const plugin of plugins) {
                    if (plugin.onMessage)
                        track(async () => {
                            await plugin.onMessage!(message);
                        });
                }
            });

            try {
                const loginSignal = AbortSignal.any([sessionSignal, AbortSignal.timeout(45_000)]);
                let rejectLogin: (() => void) | undefined;
                try {
                    await Promise.race([
                        new Promise<never>((_resolve, reject) => {
                            rejectLogin = () => reject(loginSignal.reason);
                            if (loginSignal.aborted) rejectLogin();
                            else loginSignal.addEventListener("abort", rejectLogin, { once: true });
                        }),
                        client.login(config.botToken),
                    ]);
                } finally {
                    if (rejectLogin) loginSignal.removeEventListener("abort", rejectLogin);
                }
                sessionSignal.throwIfAborted();
                const guild = await client.guilds.fetch(config.serverId);
                sessionSignal.throwIfAborted();
                log.info("Discord bot connected", { tag: client.user?.tag, guildId: guild.id });
                stopRegistration = startPeriodicTask(ctx, "Application command registration", async () => {
                    if (registered || !client.isReady()) return;
                    await guild.commands.set([
                        ...[...commands.values()].map((command) => command.data),
                        ...[...messageCommands.values()].map((command) => command.data),
                    ]);
                    sessionSignal.throwIfAborted();
                    registered = true;
                    healthy = client.isReady();
                    log.info("Registered moderator commands", {
                        commands: [...commands.keys(), ...messageCommands.keys()],
                    });
                    stopRegistration?.();
                });
                for (const plugin of plugins) {
                    await plugin.start?.();
                    log.info("Plugin started", { plugin: plugin.name });
                }
                attempt = 0;
                if (!announced && config.botChannelId) {
                    announced = true;
                    track(async () => {
                        const channel = await getTextChannel(ctx, config.botChannelId!);
                        await channel.send({ content: "vrcru-general-bot перезагружен" });
                        log.info("Sent startup notification", { channelId: channel.id });
                    });
                }
                await new Promise<void>((resolve) => {
                    if (sessionSignal.aborted) resolve();
                    else sessionSignal.addEventListener("abort", () => resolve(), { once: true });
                });
                if (!signal.aborted) throw sessionSignal.reason;
            } catch (error) {
                if (signal.aborted) break;
                if (fatalLoginError(error)) throw error;
                if (attempt === 0) log.warn("Bot connection failed; will retry", { error });
                attempt++;
            } finally {
                healthy = false;
                controller.abort();
                stopRegistration?.();
                for (const plugin of plugins.toReversed()) {
                    try {
                        await plugin.stop?.();
                    } catch (error) {
                        log.warn("Plugin shutdown failed", { plugin: plugin.name, error });
                    }
                }
                try {
                    await client.destroy();
                } catch (error) {
                    log.warn("Discord shutdown failed", { error });
                }
                await Promise.allSettled([...pending]);
            }
            if (!signal.aborted) {
                const waitMs =
                    Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5)) +
                    Math.floor(Math.random() * 1_000);
                try {
                    await delay(waitMs, undefined, { signal });
                } catch {
                    break;
                }
            }
        }
    } finally {
        stopKuma();
    }
}
