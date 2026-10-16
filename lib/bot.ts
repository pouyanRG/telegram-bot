import { Bot, InlineKeyboard } from "grammy";
import { getPrices, formatPrices } from "./prices";
import { userGuard } from "./middleware";
import { mainMenu } from "./menu";

let _bot: Bot | null = null;
const WELCOME = "سلام! 👋\nیکی از بخش‌های زیر را انتخاب کن:";
const HELP =
  "از /menu برای دیدن بخش‌ها استفاده کن.\nاین ربات در حال توسعه است و بخش‌ها به‌تدریج فعال می‌شوند.";

export function getBot() {
  if (_bot) return _bot;

  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error("BOT_TOKEN must be set");
  }

  const bot = new Bot(token);

  bot.use(userGuard);

  bot.command(["start", "menu"], (ctx) =>
    ctx.reply(WELCOME, { reply_markup: mainMenu() })
  );

  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(HELP);
  });

  const pricesKb = new InlineKeyboard().text("🔄 بروزرسانی", "prices:refresh");

  bot.callbackQuery("menu:prices", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const { data, updatedAt } = await getPrices();
      await ctx.reply(formatPrices(data, updatedAt), { reply_markup: pricesKb });
    } catch {
      await ctx.reply("⚠️ الان نمی‌توانم قیمت‌ها را بگیرم. کمی بعد دوباره امتحان کن.");
    }
  });

  bot.callbackQuery("prices:refresh", async (ctx) => {
    try {
      const { data, updatedAt } = await getPrices();
      await ctx.editMessageText(formatPrices(data, updatedAt), { reply_markup: pricesKb });
      await ctx.answerCallbackQuery({ text: "بروز شد ✅" });
    } catch {
      // اگر متن تغییر نکرده باشد تلگرام خطا می‌دهد؛ مشکلی نیست
      await ctx.answerCallbackQuery({ text: "قیمت جدیدی نیست" });
    }
  });

  bot.command("prices", async (ctx) => {
    try {
      const { data, updatedAt } = await getPrices();
      await ctx.reply(formatPrices(data, updatedAt), { reply_markup: pricesKb });
    } catch {
      await ctx.reply("⚠️ الان نمی‌توانم قیمت‌ها را بگیرم.");
    }
  });

  bot.callbackQuery(/^menu:/, (ctx) =>
    ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" })
  );

  bot.on("message:text", (ctx) =>
    ctx.reply("برای دیدن بخش‌ها /menu را بزن.", { reply_markup: mainMenu() })
  );

  bot.catch((err) => console.error("Bot error:", err));

  _bot = bot;
  return bot;
}