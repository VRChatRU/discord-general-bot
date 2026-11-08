import type { ChatInputCommandInteraction } from "discord.js";
import { discordErrorCode } from "./discord.ts";
import type { PluginContext } from "./types.ts";

type ReplyInteraction = Pick<
    ChatInputCommandInteraction,
    "id" | "ephemeral" | "deferred" | "replied" | "deleteReply"
>;

export function scheduleReplyDeletion(ctx: PluginContext, interaction: ReplyInteraction): void {
    if (
        ctx.signal.aborted ||
        interaction.ephemeral !== true ||
        (!interaction.replied && !interaction.deferred)
    )
        return;

    const remove = async () => {
        if (ctx.signal.aborted) return;
        try {
            await interaction.deleteReply();
        } catch (error) {
            if (!ctx.signal.aborted && discordErrorCode(error) !== 10008) {
                ctx.log.warn("Could not delete temporary command response", {
                    interactionId: interaction.id,
                    error,
                });
            }
        }
    };
    const cancel = () => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", cancel);
    };
    const timer = setTimeout(() => {
        ctx.signal.removeEventListener("abort", cancel);
        const pending = remove();
        ctx.pending?.add(pending);
        void pending.finally(() => ctx.pending?.delete(pending));
    }, 15_000);
    timer.unref();
    ctx.signal.addEventListener("abort", cancel, { once: true });
}
