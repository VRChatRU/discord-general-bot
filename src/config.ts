export interface Config {
    botToken: string;
    serverId: string;
    modRoleId: string;
    kumaPushUrl: string;
    botChannelId?: string;
    auditThreadId?: string;
    weeklyImageHostId?: string;
    stickyHeader: string;
    stickyFooter: string;
    stickyIconUrl?: string;
    userAgent: string;
    eventsLocation?: string;
    gistId?: string;
    githubToken?: string;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
    const optional = (key: string) => env[key]?.trim() || undefined;
    const required = (key: string) => {
        const value = optional(key);
        if (!value) throw new Error(`Missing environment variable: ${key}`);
        return value;
    };
    const id = (key: string, mandatory = false) => {
        const value = mandatory ? required(key) : optional(key);
        if (value && !/^\d{17,20}$/.test(value)) throw new Error(`Invalid Discord ID: ${key}`);
        return value;
    };
    const url = (key: string, mandatory = false) => {
        const value = mandatory ? required(key) : optional(key);
        if (!value) return undefined;
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new Error(`Invalid URL: ${key}`);
        }
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new Error(`Invalid HTTP URL: ${key}`);
        }
        return value;
    };
    const eventsLocation = optional("VRC_EVENTS_REQ_LOC");
    const gistId = optional("GIST_ID");
    const githubToken = optional("GITHUB_TOKEN");
    const eventSettings = [eventsLocation, gistId, githubToken].filter(Boolean).length;
    if (eventSettings !== 0 && eventSettings !== 3) {
        throw new Error(
            "Set VRC_EVENTS_REQ_LOC, GIST_ID and GITHUB_TOKEN together, or leave all three empty",
        );
    }
    if (gistId && !/^[a-f0-9]+$/i.test(gistId)) throw new Error("Invalid GIST_ID");
    const stickyHeader = optional("STICKY_HEADER") ?? "Внимание!";
    const stickyFooter = optional("STICKY_FOOTER") ?? "Модерация сервера";
    if (stickyHeader.length > 256 || stickyFooter.length > 2048) {
        throw new Error("STICKY_HEADER or STICKY_FOOTER exceeds Discord limits");
    }
    return {
        botToken: required("BOT_TOKEN"),
        serverId: id("SERVER_ID", true)!,
        modRoleId: id("MOD_ROLE_ID", true)!,
        kumaPushUrl: url("KUMA_PUSH_URL", true)!,
        botChannelId: id("BOT_CHANNEL_ID"),
        auditThreadId: id("AUDIT_THREAD_ID"),
        weeklyImageHostId: id("WEEKLY_IMG_HOST_ID"),
        stickyHeader,
        stickyFooter,
        stickyIconUrl: url("STICKY_ICON_URL"),
        userAgent: optional("USER_AGENT") ?? "VRCRU-Discord-General-Bot/4.0",
        eventsLocation,
        gistId,
        githubToken,
    };
}
