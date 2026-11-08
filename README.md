# Discord General Bot

A modular Discord bot for sticky messages, announcements, banners, VRChat presence, and event publishing.

1. Install the latest stable Bun (1.4.4+).
2. Run `bun install --frozen-lockfile` in this directory.
3. Copy `example.env` to `.env` and fill the required values. Banner DMs, startup notifications, and Gist publishing are optional.
4. Invite the bot with `bot` and `applications.commands`. Grant View Channel, Send Messages, Read Message History, Attach Files, Embed Links, and Manage Server (for banners). Grant View Channel, Send Messages in Threads, and Embed Links for `AUDIT_THREAD_ID`. Privileged gateway intents are unnecessary.
5. Commands require the configured moderator role or Administrator. Defaults hide commands from members without Manage Messages. For visibility by exact role, configure Server Settings → Integrations → this bot: disable @everyone and enable your moderator role. Administrators always have access.
6. Run `bun run start`. Check with `bun check` and `bun test`.
