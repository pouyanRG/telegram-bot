import { Bot } from "grammy";
import { getDb } from "./db";
import { users } from "./schema";

let _bot: Bot | null = null;

export function getBot() {
  if (_bot) return _bot;

  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error("BOT_TOKEN must be set");
  }

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    // اول جواب بده تا حتی با مشکل دیتابیس، ربات ساکت نماند
    await ctx.reply("سلام! ربات فعال است ✅");

    // بعد کاربر را در دیتابیس ذخیره کن
    try {
      if (ctx.from) {
        await getDb()
          .insert(users)
          .values({
            telegramId: ctx.from.id,
            username: ctx.from.username ?? null,
            firstName: ctx.from.first_name ?? null,
          })
          .onConflictDoNothing();
      }
    } catch (e) {
      console.error("DB error:", e);
    }
  });

  bot.on("message:text", (ctx) => ctx.reply(`گفتی: ${ctx.message.text}`));

  bot.catch((err) => console.error("Bot error:", err));

  _bot = bot;
  return bot;
}