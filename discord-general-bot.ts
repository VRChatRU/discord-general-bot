import { join } from "node:path";
import { loadConfig } from "./src/config.ts";
import { Logger } from "./src/logger.ts";
import { runBot } from "./src/runtime.ts";
import { Store } from "./src/store.ts";

async function main() {
    const secrets = [Bun.env.BOT_TOKEN, Bun.env.GITHUB_TOKEN, Bun.env.KUMA_PUSH_URL].filter(
        (value): value is string => Boolean(value),
    );
    if (Bun.env.GITHUB_TOKEN) secrets.push(Bun.env.GITHUB_TOKEN.replace(/^(?:Bearer|token)\s+/i, ""));
    if (Bun.env.KUMA_PUSH_URL) {
        try {
            secrets.push(new URL(Bun.env.KUMA_PUSH_URL).pathname.split("/").at(-1)!);
        } catch {
            /* Validated below. */
        }
    }
    const log = new Logger(join(import.meta.dir, "discord-general-bot.log"), secrets);
    const controller = new AbortController();
    let store: Store | undefined;
    const stop = () => {
        if (!controller.signal.aborted) {
            log.info("Stopping bot");
            controller.abort();
        }
    };
    const unexpected = (error: unknown) => {
        log.error("Unexpected application error", { error });
        process.exitCode = 1;
        stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.on("unhandledRejection", unexpected);
    process.on("uncaughtException", unexpected);
    try {
        const config = loadConfig();
        store = new Store(join(import.meta.dir, "discord-general-bot.db"));
        log.info("Starting bot", { bun: Bun.version });
        await runBot(config, log, store, controller.signal);
    } catch (error) {
        log.error("Bot stopped with an error", { error });
        process.exitCode = 1;
    } finally {
        controller.abort();
        store?.close();
        log.info("Bot stopped");
        await log.close();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        process.removeListener("unhandledRejection", unexpected);
        process.removeListener("uncaughtException", unexpected);
    }
}

if (import.meta.main) await main();
