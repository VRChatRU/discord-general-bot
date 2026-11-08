import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { handleCommand, isModerator } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import { startKuma } from "../src/kuma.ts";
import { Logger } from "../src/logger.ts";
import { Store } from "../src/store.ts";
import { startPeriodicTask } from "../src/tasks.ts";
import type { Command, PluginContext } from "../src/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
    jest.useRealTimers();
    for (const stop of cleanup.splice(0)) stop();
});

const microtasks = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("command authorization and errors", () => {
    function fixtures({ role = true, admin = false, guild = "guild" } = {}) {
        const ctx = {
            config: { serverId: "guild", modRoleId: "mod" },
            signal: new AbortController().signal,
            log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
        } as unknown as PluginContext;
        const command: Command = {
            data: { name: "test", description: "test" },
            execute: mock(async () => {}),
        };
        const interaction = {
            guildId: guild,
            commandName: "test",
            user: { id: "user" },
            channelId: "channel",
            memberPermissions: {
                has: (permission: bigint) => permission === PermissionFlagsBits.Administrator && admin,
            },
            member: { roles: { cache: { has: () => role } } },
            inCachedGuild: () => true,
            replied: false,
            deferred: false,
            reply: mock(async () => {}),
            deferReply: mock(async () => {
                interaction.deferred = true;
            }),
            editReply: mock(async () => {}),
        };
        const run = () =>
            handleCommand(
                ctx,
                new Map([["test", command]]),
                interaction as unknown as ChatInputCommandInteraction,
            );
        return { ctx, command, interaction, run };
    }

    test("ordinary members cannot execute commands", async () => {
        const { command, interaction, run } = fixtures({ role: false });
        await run();
        expect(command.execute).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledTimes(1);
        expect(interaction.reply.mock.calls[0]).toMatchObject([{ flags: 64 }]);
    });

    test("configured moderators and administrators are allowed", async () => {
        for (const options of [{ role: true }, { role: false, admin: true }]) {
            const { command, interaction, run } = fixtures(options);
            expect(isModerator(interaction as unknown as ChatInputCommandInteraction<"cached">, "mod")).toBe(
                true,
            );
            await run();
            expect(command.execute).toHaveBeenCalledTimes(1);
            expect(interaction.deferReply).toHaveBeenCalledTimes(1);
        }
    });

    test("commands in another guild are rejected even for an administrator", async () => {
        const { command, run } = fixtures({ admin: true, guild: "other" });
        await run();
        expect(command.execute).not.toHaveBeenCalled();
    });

    test("a failed command and failed error reply do not escape the boundary", async () => {
        const { ctx, command, interaction, run } = fixtures();
        (command.execute as ReturnType<typeof mock>).mockRejectedValue(new Error("Network unavailable"));
        interaction.editReply.mockRejectedValue(new Error("Interaction expired"));
        await run();
        expect(ctx.log.warn).toHaveBeenCalledTimes(2);
    });
});

describe("persistent state", () => {
    test("sticky state, deletion intent, snowflakes and publication cache survive reopening SQLite", () => {
        const path = join(tmpdir(), `discord-general-bot-${crypto.randomUUID()}.db`);
        let store = new Store(path);
        cleanup.push(() => {
            store.close();
            for (const suffix of ["", "-wal", "-shm"]) {
                try {
                    unlinkSync(path + suffix);
                } catch {
                    /* SQLite may already have removed sidecars. */
                }
            }
        });
        store.setSticky("1234567890123456789", "Message");
        store.setStickyMessage("1234567890123456789", "9876543210987654321");
        store.retireSticky("1234567890123456789");
        store.setState("events:last", "[]");
        const nonce = store.getSticky("1234567890123456789")!.nonce;
        store.close();
        store = new Store(path);
        expect(store.getSticky("1234567890123456789")).toMatchObject({
            messageId: "9876543210987654321",
            content: "Message",
            nonce,
            retiring: 1,
            dirty: 1,
        });
        expect(store.getState("events:last")).toBe("[]");
    });
});

describe("background tasks and Kuma", () => {
    test("periodic jobs cannot overlap, retry without log spam, and report recovery", async () => {
        jest.useFakeTimers();
        const controller = new AbortController();
        const ctx = {
            signal: controller.signal,
            log: { info: mock(() => {}), warn: mock(() => {}) },
            pending: new Set<Promise<unknown>>(),
        } as unknown as PluginContext;
        let release!: () => void;
        const task = mock(async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        });
        const stop = startPeriodicTask(ctx, "Job", task, { intervalMs: 100 });
        cleanup.push(() => {
            controller.abort();
            stop();
        });
        jest.advanceTimersByTime(1_000);
        expect(task).toHaveBeenCalledTimes(1);
        release();
        await microtasks();
        task.mockRejectedValue(new Error("offline"));
        jest.advanceTimersByTime(100);
        await microtasks();
        jest.advanceTimersByTime(100);
        await microtasks();
        expect(ctx.log.warn).toHaveBeenCalledTimes(1);
        task.mockResolvedValue(undefined);
        jest.advanceTimersByTime(100);
        await microtasks();
        expect(ctx.log.info).toHaveBeenCalledTimes(1);
        controller.abort();
        const count = task.mock.calls.length;
        jest.advanceTimersByTime(1_000);
        expect(task).toHaveBeenCalledTimes(count);
    });

    test("Kuma waits 60 seconds, skips unhealthy periods and survives a network failure", async () => {
        jest.useFakeTimers();
        const controller = new AbortController();
        let healthy = true;
        const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
        const stop = startKuma("https://status.example.test/api/push/test", () => healthy, controller.signal);
        cleanup.push(() => {
            controller.abort();
            stop();
            fetchSpy.mockRestore();
        });
        jest.advanceTimersByTime(59_999);
        expect(fetchSpy).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        await microtasks();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        healthy = false;
        jest.advanceTimersByTime(60_000);
        await microtasks();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        healthy = true;
        fetchSpy.mockResolvedValue(new Response("OK"));
        jest.advanceTimersByTime(60_000);
        await microtasks();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        controller.abort();
        jest.advanceTimersByTime(60_000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});

describe("configuration and logging", () => {
    const env = {
        BOT_TOKEN: "test-token",
        SERVER_ID: "123456789012345678",
        MOD_ROLE_ID: "223456789012345678",
        KUMA_PUSH_URL: "https://status.example.test/api/push/test",
    };
    test("rejects incomplete event configuration without exposing its token", () => {
        expect(() => loadConfig({ ...env, GITHUB_TOKEN: "secret" })).toThrow("Set VRC_EVENTS_REQ_LOC");
        expect(loadConfig(env).eventsLocation).toBeUndefined();
    });

    test("logs are flushed to file and redact secrets even inside errors", async () => {
        const path = join(tmpdir(), `discord-general-bot-${crypto.randomUUID()}.log`);
        const log = new Logger(path, ["private-token"]);
        const consoleSpy = spyOn(console, "warn").mockImplementation(() => {});
        cleanup.push(() => {
            consoleSpy.mockRestore();
            try {
                unlinkSync(path);
            } catch {}
        });
        log.warn("Request failed", { error: new Error("URL contains private-token"), id: 123n });
        await log.close();
        const line = await Bun.file(path).text();
        expect(line).not.toContain("private-token");
        expect(JSON.parse(line)).toMatchObject({
            level: "warn",
            id: "123",
            error: { message: "URL contains [REDACTED]" },
        });
    });

    test("restarting the logger appends intact JSON lines instead of overwriting history", async () => {
        const path = join(tmpdir(), `discord-general-bot-${crypto.randomUUID()}.log`);
        const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
        cleanup.push(() => {
            consoleSpy.mockRestore();
            try {
                unlinkSync(path);
            } catch {}
        });
        const first = new Logger(path);
        first.info("First process");
        await first.close();
        const second = new Logger(path);
        second.info("Second process");
        await second.close();
        const messages = (await Bun.file(path).text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).message);
        expect(messages).toEqual(["First process", "Second process"]);
    });
});
