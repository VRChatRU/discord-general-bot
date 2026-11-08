# Discord General Bot

A modular Discord bot for sticky messages, announcements, banners, VRChat presence, and event publishing.

1. Install the latest stable Bun (1.4.4+).
2. Run `bun install --frozen-lockfile` in this directory.
3. Copy `example.env` to `.env` and fill the required values. Banner DMs, startup notifications, and Gist publishing are optional.
4. Invite the bot with `bot` and `applications.commands`. Grant View Channel, Send Messages, Read Message History, Attach Files, Embed Links, and Manage Server (for banners). Grant View Channel, Send Messages in Threads, and Embed Links for `AUDIT_THREAD_ID`. Privileged gateway intents are unnecessary.
5. Commands require the configured moderator role or Administrator. Defaults hide commands from members without Manage Messages. For visibility by exact role, configure Server Settings → Integrations → this bot: disable @everyone and enable your moderator role. Administrators always have access.
6. Run `bun run start`. Check with `bun check` and `bun test`.

Commands: `/stick channel text`, `/delstick channel`, `/say [user|channel] [message-id] [message] [media]`. `/say` edits by message link or ID in the selected channel/DM; new media replaces attachments, text-only edits preserve them. Media is capped at 100 MiB and Discord's destination limit.

Message menu: «Редактировать сообщение бота» edits text in channels and threads. Private replies disappear after 15 seconds. The user in `WEEKLY_IMG_HOST_ID` can change the banner by sending an image in a DM.

State: `discord-general-bot.db`; logs: `discord-general-bot.log` (next to the entry point). Keep the database across deployments. Kuma starts after 60 seconds and stays silent; disconnected bots do not send healthy heartbeats.

`AUDIT_THREAD_ID` receives /say and context-edit audit logs plus incoming DMs, without pings. Banner upload DMs are excluded. Pending logs remain in SQLite until delivered.
