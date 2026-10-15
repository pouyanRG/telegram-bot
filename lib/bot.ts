import { Bot } from "grammy";
import { db } from "./db";
import { users } from "./schema";

export const bot = new Bot(process.env.BOT_TOKEN!);

bot.command("start", async (ctx) => {
  try {
    await db
      .insert(users)
      .values({
        telegramId: ctx.from!.id,
        username: ctx.from!.username ?? null,
        firstName: ctx.from!.first_name ?? null,
      })
      .onConflictDoNothing();
  } catch (e) {
    console.error("DB error:", e);
  }
  await ctx.reply("سلام! ربات فعال است ✅");
});

bot.on("message:text", (ctx) => ctx.reply(`گفتی: ${ctx.message.text}`));

bot.catch((err) => console.error("Bot error:", err));
