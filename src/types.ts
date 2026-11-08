import type {
    ChatInputCommandInteraction,
    Client,
    Message,
    MessageContextMenuCommandInteraction,
    ModalSubmitInteraction,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    RESTPostAPIContextMenuApplicationCommandsJSONBody,
} from "discord.js";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "./store.ts";
import type { AuditRecorder } from "./audit.ts";

export interface Command {
    data: RESTPostAPIChatInputApplicationCommandsJSONBody;
    execute(interaction: ChatInputCommandInteraction<"cached">): Promise<void>;
}

export interface MessageCommand {
    data: RESTPostAPIContextMenuApplicationCommandsJSONBody;
    execute(interaction: MessageContextMenuCommandInteraction<"cached">): Promise<void>;
}

export interface ModalHandler {
    prefix: string;
    execute(interaction: ModalSubmitInteraction<"cached">): Promise<void>;
}

export interface Plugin {
    name: string;
    commands?: Command[];
    messageCommands?: MessageCommand[];
    modals?: ModalHandler[];
    start?(): void | Promise<void>;
    onMessage?(message: Message): void | Promise<void>;
    stop?(): void | Promise<void>;
}

export interface PluginContext {
    client: Client;
    config: Config;
    log: Logger;
    store: Store;
    signal: AbortSignal;
    pending?: Set<Promise<unknown>>;
    audit?: AuditRecorder;
}
