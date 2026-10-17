import { Bot, GrammyError, InlineKeyboard, Keyboard, type Context } from "grammy";
import {
  addAdmin,
  isAdminUser,
  isOwner,
  listAdmins,
  ownerId,
  removeAdmin,
  getThinkingSticker,
  setPendingSticker,
  setThinkingSticker,
  takePendingSticker,
} from "./admins";
import { SETTINGS, quotaExceededMessage } from "./config";
import { consumeQuota } from "./quota";
import { getPrices, formatPrices, findCoin, formatCoin } from "./prices";
import { userGuard } from "./middleware";
import { mainMenu } from "./menu";
import { handleVoice, voiceGuide } from "./voice";

let _bot: Bot | null = null;

// ---------- متن‌ها ----------

const WELCOME = "👋 <b>سلام!</b>\nیکی از بخش‌های زیر را انتخاب کن:";

const HELP_USER = [
  "ℹ️ <b>راهنما</b>",
  "",
  "▫️ /menu — منوی اصلی",
  "▫️ /prices — وضعیت بازار و قیمت‌ها",
  "▫️ نام یا نماد هر ارز (مثل <code>btc</code> یا <code>solana</code>) را بفرست تا قیمتش را ببینی",
  "▫️ یک ویس بفرست تا به متن تبدیل شود",
  "",
  "<i>ربات در حال توسعه است و بخش‌ها به‌تدریج فعال می‌شوند.</i>",
].join("\n");

const HELP_ADMIN = [
  "",
  "🛠 <b>بخش ادمین</b>",
  "▫️ دکمه‌ی «تنظیم استیکر فکرکردن» — استیکری که هنگام پردازش هوش مصنوعی نمایش داده می‌شود",
].join("\n");

const HELP_OWNER = [
  "▫️ /addadmin <code>آیدی</code> — افزودن ادمین فرعی",
  "▫️ /removeadmin <code>آیدی</code> — حذف ادمین فرعی",
  "▫️ /admins — فهرست ادمین‌ها",
].join("\n");

const HTML = { parse_mode: "HTML" as const };
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

// ---------- کیبوردها ----------

const STICKER_BTN = "🎞 تنظیم استیکر فکرکردن";

// کیبورد ثابت پایین چت؛ فقط به چت ادمین‌ها فرستاده می‌شود
const adminKb = new Keyboard().text(STICKER_BTN).resized().persistent();

const homeKb = new InlineKeyboard().text("🏠 منوی اصلی", "menu:home");

const pricesKb = new InlineKeyboard()
  .text("🔄 بروزرسانی", "prices:refresh")
  .row()
  .text("🏠 منوی اصلی", "menu:home");

const cancelStickerKb = new InlineKeyboard().text("❌ انصراف", "admin:sticker_cancel");

function coinKb(id: string) {
  return new InlineKeyboard()
    .text("🔄 بروزرسانی", `coin:${id}`)
    .url("🌐 CoinGecko", `https://www.coingecko.com/en/coins/${id}`)
    .row()
    .text("📊 بازار", "menu:prices")
    .text("🏠 منو", "menu:home");
}

// ---------- ابزارهای کمکی ----------

const isNotModified = (e: unknown) =>
  e instanceof GrammyError && e.description.includes("message is not modified");

/** تلاش برای ویرایش پیام فعلی؛ اگر نشد (مثلاً پیام قدیمی)، پیام جدید می‌فرستد */
async function editOrReply(ctx: Context, text: string, reply_markup: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, { ...HTML, reply_markup });
  } catch (e) {
    if (!isNotModified(e)) await ctx.reply(text, { ...HTML, reply_markup });
  }
}

function parseId(raw: unknown) {
  const n = Number(String(raw ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function sendPrices(ctx: Context) {
  await ctx.replyWithChatAction("typing");
  try {
    const { data, updatedAt } = await getPrices();
    await ctx.reply(formatPrices(data, updatedAt), { ...HTML, reply_markup: pricesKb });
  } catch {
    await ctx.reply("⚠️ الان نمی‌توانم قیمت‌ها را بگیرم. کمی بعد دوباره امتحان کن.");
  }
}

// ---------- ساخت ربات ----------

export function getBot() {
  if (_bot) return _bot;

  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN must be set");

  const bot = new Bot(token);

  bot.use(userGuard);

  // ================= دستورهای عمومی =================

  bot.command(["start", "menu"], async (ctx) => {
    await ctx.reply(WELCOME, { ...HTML, reply_markup: mainMenu() });
    // کیبورد پایین فقط برای ادمین‌ها (ادمین اصلی + فرعی)
    if (ctx.from && (await isAdminUser(ctx.from.id))) {
      await ctx.reply("🛠 دکمه‌های ادمین فعال شد.", { reply_markup: adminKb });
    }
  });

  bot.command("help", async (ctx) => {
    const id = ctx.from?.id;
    let text = HELP_USER;
    if (id && (await isAdminUser(id))) text += "\n" + HELP_ADMIN;
    if (id && isOwner(id)) text += "\n" + HELP_OWNER;
    await ctx.reply(text, { ...HTML, reply_markup: homeKb });
  });

  bot.command("prices", sendPrices);

  // ================= بخش ادمین =================

  // --- دکمه‌ی «تنظیم استیکر فکرکردن» ---
  bot.hears(STICKER_BTN, async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || !(await isAdminUser(uid))) return; // برای غیرادمین هیچ واکنشی نیست

    await setPendingSticker(uid);

    // اگر استیکری از قبل تنظیم شده، پیش‌نمایشش را نشان بده
    const current = await getThinkingSticker().catch(() => null);
    if (current) {
      await ctx.reply("استیکر فعلی:");
      await ctx.replyWithSticker(current).catch(() => {});
    }

    await ctx.reply(
      "🎞 حالا استیکر جدید (ترجیحاً متحرک) را بفرست.\n⏳ تا ۱۰ دقیقه معتبر است.",
      { reply_markup: cancelStickerKb }
    );
  });

  bot.callbackQuery("admin:sticker_cancel", async (ctx) => {
    if (await isAdminUser(ctx.from.id)) await takePendingSticker(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    await ctx.editMessageText("❌ تنظیم استیکر لغو شد.").catch(() => {});
  });

  // --- دریافت استیکر (فقط وقتی ادمین در حالت انتظار است) ---
  bot.on("message:sticker", async (ctx) => {
    const uid = ctx.from.id;
    if (!(await isAdminUser(uid))) return;
    if (!(await takePendingSticker(uid))) return;

    await setThinkingSticker(ctx.message.sticker.file_id);
    await ctx.reply("✅ استیکر فکرکردن ذخیره شد. از این به بعد هنگام پردازش هوش مصنوعی نمایش داده می‌شود.");
  });

  // --- فقط ادمین اصلی (صاحب توکن): مدیریت ادمین‌های فرعی ---
  bot.command("addadmin", async (ctx) => {
    const owner = ctx.from?.id;
    if (!owner || !isOwner(owner)) return;

    const id = parseId(ctx.match);
    if (!id) return void (await ctx.reply("استفاده: /addadmin 123456789"));
    if (id === ownerId()) return void (await ctx.reply("تو ادمین اصلی هستی 👑"));

    await addAdmin(id, owner);

    // به ادمین جدید خبر بده و کیبوردش را فعال کن (اگر قبلاً ربات را استارت کرده باشد)
    const notified = await ctx.api
      .sendMessage(id, "🛠 شما به‌عنوان ادمین ربات اضافه شدید.", { reply_markup: adminKb })
      .then(() => true)
      .catch(() => false);

    await ctx.reply(
      `✅ ${id} به ادمین‌های فرعی اضافه شد.` +
        (notified ? "" : "\n⚠️ هنوز ربات را استارت نکرده؛ باید یک بار /start بزند.")
    );
  });

  bot.command("removeadmin", async (ctx) => {
    const owner = ctx.from?.id;
    if (!owner || !isOwner(owner)) return;

    const id = parseId(ctx.match);
    if (!id) return void (await ctx.reply("استفاده: /removeadmin 123456789"));
    if (id === ownerId()) return void (await ctx.reply("ادمین اصلی قابل حذف نیست."));

    await removeAdmin(id);
    // کیبورد ادمین را از چت او پاک کن (دسترسی سمت سرور هم بسته شده است)
    await ctx.api
      .sendMessage(id, "دسترسی ادمین شما برداشته شد.", { reply_markup: { remove_keyboard: true } })
      .catch(() => {});
    await ctx.reply(`🗑 ${id} از ادمین‌ها حذف شد.`);
  });

  bot.command("admins", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const list = await listAdmins();
    await ctx.reply(
      [
        `👑 ادمین اصلی: ${ownerId()}`,
        "",
        ...(list.length ? list.map((a) => `▫️ ${a.userId}`) : ["ادمین فرعی‌ای وجود ندارد."]),
      ].join("\n")
    );
  });

  // ================= ناوبری منو (ویرایش همان پیام) =================

  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, WELCOME, mainMenu());
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, HELP_USER, homeKb);
  });

  // ================= قیمت‌ها =================

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

  // ================= ویس به متن =================

  bot.callbackQuery("menu:voice", async (ctx) => {
    await ctx.answerCallbackQuery();
    await voiceGuide(ctx);
  });

  bot.on("message:voice", handleVoice);
  bot.on("message:audio", (ctx) =>
    ctx.reply("فعلاً فقط ویس تلگرام پشتیبانی می‌شود 🎙")
  );

  // ================= بخش‌های در دست ساخت =================

  bot.callbackQuery(/^menu:/, (ctx) =>
    ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" })
  );

  // ================= جستجوی ارز =================

  // دکمه‌ی بروزرسانی کارت ارز
  bot.callbackQuery(/^coin:(.+)$/, async (ctx) => {
    try {
      const coin = await findCoin(ctx.match[1], { byId: true });
      if (!coin) return void (await ctx.answerCallbackQuery({ text: "ارز پیدا نشد" }));
      await ctx.editMessageText(formatCoin(coin), {
        ...HTML,
        ...NO_PREVIEW,
        reply_markup: coinKb(coin.id),
      });
      await ctx.answerCallbackQuery({ text: "بروز شد ✅" });
    } catch (e) {
      if (!isNotModified(e)) console.error("coin refresh error:", e);
      await ctx.answerCallbackQuery({
        text: isNotModified(e) ? "قیمت جدیدی نیست" : "⚠️ خطا در دریافت قیمت",
      });
    }
  });

  // متن آزاد: نام یا نماد ارز (باید بعد از همه‌ی hears/commandها بیاید)
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    // فقط ورودی لاتین کوتاه را به‌عنوان نام/نماد ارز بررسی کن
    if (!SETTINGS.coinQueryPattern.test(text)) {
      return void (await ctx.reply("برای دیدن بخش‌ها /menu را بزن.", { reply_markup: mainMenu() }));
    }

    // سهمیه‌ی روزانه‌ی جستجوی ارز (ادمین‌ها معاف)
    if (!(await isAdminUser(ctx.from.id))) {
      const q = await consumeQuota(ctx.from.id, "coin");
      if (!q.allowed) {
        return void (await ctx.reply(quotaExceededMessage("coin"), HTML));
      }
    }

    await ctx.replyWithChatAction("typing");
    try {
      const coin = await findCoin(text);
      if (!coin) {
        return void (await ctx.reply("🔎 ارزی با این نام یا نماد پیدا نشد. یک بار دیگر امتحان کن.", {
          reply_markup: mainMenu(),
        }));
      }
      await ctx.reply(formatCoin(coin), {
        ...HTML,
        ...NO_PREVIEW,
        reply_markup: coinKb(coin.id),
      });
    } catch (e) {
      console.error("coin lookup error:", e);
      await ctx.reply("⚠️ الان نمی‌توانم این ارز را بگیرم. کمی بعد دوباره امتحان کن.");
    }
  });

  bot.catch((err) => console.error("Bot error:", err));

  _bot = bot;
  return bot;
}