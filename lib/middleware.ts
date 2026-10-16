import type { Context, NextFunction } from "grammy";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { users } from "./schema";

export async function userGuard(ctx: Context, next: NextFunction) {
  if (!ctx.from || ctx.chat?.type !== "private") return;

  try {
    const [row] = await getDb()
      .insert(users)
      .values({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        language: ctx.from.language_code ?? null,
      })
      .onConflictDoUpdate({
        target: users.telegramId,
        set: {
          username: ctx.from.username ?? null,
          firstName: ctx.from.first_name ?? null,
          language: ctx.from.language_code ?? null,
          lastSeenAt: sql`now()`,
        },
      })
      .returning({ isBanned: users.isBanned });

    if (row?.isBanned) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply("⛔️ دسترسی شما به ربات مسدود شده است.");
      return;
    }
  } catch (e) {
    console.error("userGuard DB error:", e);
  }

  await next();
}
