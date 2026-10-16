import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import { getPrices, formatPrices, findCoin, formatCoin } from "./prices";
import { userGuard } from "./middleware";
import { mainMenu } from "./menu";

let _bot: Bot | null = null;

const WELCOME = "👋 <b>سلام!</b>\nیکی از بخش‌های زیر را انتخاب کن:";
const HELP = [
  "ℹ️ <b>راهنما</b>",
  "",
  "▫️ /menu — منوی اصلی",
  "▫️ /prices — وضعیت بازار و قیمت‌ها",
  "▫️ نام یا نماد هر ارز (مثل <code>btc</code> یا <code>solana</code>) را بفرست تا قیمتش را ببینی",
  "",
  "<i>ربات در حال توسعه است و بخش‌ها به‌تدریج فعال می‌شوند.</i>",
].join("\n");

const HTML = { parse_mode: "HTML" as const };
const homeKb = new InlineKeyboard().text("🏠 منوی اصلی", "menu:home");
const pricesKb = new InlineKeyboard()
  .text("🔄 بروزرسانی", "prices:refresh")
  .row()
  .text("🏠 منوی اصلی", "menu:home");

const isNotModified = (e: unknown) =>
  e instanceof GrammyError && e.description.includes("message is not modified");

async function sendPrices(ctx: Context) {
  await ctx.replyWithChatAction("typing");
  try {
    const { data, updatedAt } = await getPrices();
    await ctx.reply(formatPrices(data, updatedAt), { ...HTML, reply_markup: pricesKb });
  } catch {
    await ctx.reply("⚠️ الان نمی‌توانم قیمت‌ها را بگیرم. کمی بعد دوباره امتحان کن.");
  }
}

export function getBot() {
  if (_bot) return _bot;

  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN must be set");

  const bot = new Bot(token);

  bot.use(userGuard);

  // ---------- دستورها ----------
  bot.command(["start", "menu"], (ctx) =>
    ctx.reply(WELCOME, { ...HTML, reply_markup: mainMenu() })
  );
  bot.command("help", (ctx) => ctx.reply(HELP, { ...HTML, reply_markup: homeKb }));
  bot.command("prices", sendPrices);

  // ---------- ناوبری منو (ویرایش همان پیام) ----------
  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(WELCOME, { ...HTML, reply_markup: mainMenu() });
    } catch (e) {
      if (!isNotModified(e)) await ctx.reply(WELCOME, { ...HTML, reply_markup: mainMenu() });
    }
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(HELP, { ...HTML, reply_markup: homeKb });
    } catch (e) {
      if (!isNotModified(e)) await ctx.reply(HELP, { ...HTML, reply_markup: homeKb });
    }
  });

  // ---------- قیمت‌ها ----------
  bot.callbackQuery("menu:prices", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPrices(ctx);
  });

  bot.callbackQuery("prices:refresh", async (ctx) => {
    try {
      const { data, updatedAt } = await getPrices();
      await ctx.editMessageText(formatPrices(data, updatedAt), {
        ...HTML,
        reply_markup: pricesKb,
      });
      await ctx.answerCallbackQuery({ text: "بروز شد ✅" });
    } catch (e) {
      if (!isNotModified(e)) console.error("prices:refresh error:", e);
      await ctx.answerCallbackQuery({
        text: isNotModified(e) ? "قیمت جدیدی نیست" : "⚠️ خطا در دریافت قیمت",
      });
    }
  });

  // ---------- بخش‌های در دست ساخت ----------
  bot.callbackQuery(/^menu:/, (ctx) =>
    ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" })
  );

  // ---------- جستجوی ارز (دکمه‌ی بروزرسانی کارت ارز) ----------
  bot.callbackQuery(/^coin:(.+)$/, async (ctx) => {
    try {
      const coin = await findCoin(ctx.match[1], { byId: true });
      if (!coin) return ctx.answerCallbackQuery({ text: "ارز پیدا نشد" });
      await ctx.editMessageText(formatCoin(coin), {
        ...HTML,
        reply_markup: coinKb(coin.id),
        link_preview_options: { is_disabled: true },
      });
      await ctx.answerCallbackQuery({ text: "بروز شد ✅" });
    } catch (e) {
      if (!isNotModified(e)) console.error("coin refresh error:", e);
      await ctx.answerCallbackQuery({
        text: isNotModified(e) ? "قیمت جدیدی نیست" : "⚠️ خطا در دریافت قیمت",
      });
    }
  });

  // ---------- متن آزاد: جستجوی ارز با نام یا نماد ----------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    // فقط ورودی لاتین کوتاه را به‌عنوان نام/نماد ارز بررسی کن
    if (/^[A-Za-z0-9 .\-]{1,30}$/.test(text)) {
      await ctx.replyWithChatAction("typing");
      try {
        const coin = await findCoin(text);
        if (coin) {
          return ctx.reply(formatCoin(coin), {
            ...HTML,
            reply_markup: coinKb(coin.id),
            link_preview_options: { is_disabled: true },
          });
        }
        return ctx.reply("🔎 ارزی با این نام یا نماد پیدا نشد. یک بار دیگر امتحان کن.", {
          reply_markup: mainMenu(),
        });
      } catch (e) {
        console.error("coin lookup error:", e);
        return ctx.reply("⚠️ الان نمی‌توانم این ارز را بگیرم. کمی بعد دوباره امتحان کن.");
      }
    }

    return ctx.reply("برای دیدن بخش‌ها /menu را بزن.", { reply_markup: mainMenu() });
  });

  bot.catch((err) => console.error("Bot error:", err));

  _bot = bot;
  return bot;
}

function coinKb(id: string) {
  return new InlineKeyboard()
    .text("🔄 بروزرسانی", `coin:${id}`)
    .url("🌐 CoinGecko", `https://www.coingecko.com/en/coins/${id}`)
    .row()
    .text("📊 بازار", "menu:prices")
    .text("🏠 منو", "menu:home");
}