import { UserError } from "./errors";
import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";

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
  withThinking,
} from "./admins";

import { SETTINGS, quotaExceededMessage } from "./config";
import { consumeQuota, refundQuota } from "./quota";
import { getPrices, formatPrices, findCoin, formatCoin } from "./prices";
import { dedupeUpdates, userGuard } from "./middleware";
import { mainMenu, BTN, idleKb, waitingKb, chatKb } from "./menu";
import { handleVoice, voiceGuide } from "./voice";
import { clearMode, setVoiceMode } from "./mode";
import { joinQueue, leaveChat, getAnon } from "./anon";
import { NEWS_CATEGORIES, NEWS_CATEGORY_IDS, WINDOWS, type WindowId } from "./news/categories";
import { getNews, formatNews } from "./news";

let _bot: Bot | null = null;

// ---------- متن‌ها ----------

const WELCOME = "👋 <b>سلام!</b>\nیکی از بخش‌های زیر را انتخاب کن:";

const SETTINGS_TEXT = "⚙️ <b>Setting</b>\nیکی از گزینه‌ها را انتخاب کن:";

const HELP_USER = [
  "ℹ️ <b>راهنما</b>",
  "",
  "▫️ /menu — منوی اصلی",
  "▫️ /prices — وضعیت بازار و ‌ها",
  "▫️ نام یا نماد هر ارز (مثل <code>btc</code> یا <code>solana</code> یا <code>بیت‌کوین</code>) را بفرست تا رمزارز را ببینی",
  "▫️ برای تبدیل ویس به متن، از منو «🎙 ویس به متن» را بزن و بعد ویس بفرست",
  "▫️ «🎭 به یه ناشناس وصلم کن!» — چت ناشناس با یک نفر دیگر",
  "▫️ /end — پایان چت ناشناس",
  "",
  "<i>ربات در حال توسعه است و بخش‌ها به‌تدریج فعال می‌شوند.</i>",
].join("\n");

const HELP_ADMIN = [
  "",
  "🛠 <b>بخش ادمین</b>",
  "▫️ منو ← «⚙️ Setting» — تنظیمات ادمین (مثل استیکر فکرکردن)",
  "▫️ بخش «📰 خبر شخصی» فقط برای ادمین‌ها فعال است",
].join("\n");

const HELP_OWNER = [
  "▫️ /addadmin <code>آیدی</code> — افزودن ادمین فرعی",
  "▫️ /removeadmin <code>آیدی</code> — حذف ادمین فرعی",
  "▫️ /admins — فهرست ادمین‌ها",
].join("\n");

const ANON_MATCHED =
  "✅ وصل شدی! سلام کن 👋\nهرچی بفرستی (متن، عکس، ویس، استیکر، ...) ناشناس برای طرف مقابل می‌رسد.";

const HTML = { parse_mode: "HTML" as const };
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

// ---------- نام فارسی ارزها ----------

// کلیدها بدون فاصله و نیم‌فاصله و با «ی/ک» فارسی (به normalizeFa نگاه کن)
const FA_COINS: Record<string, string> = {
  بیتکوین: "bitcoin",
  اتریوم: "ethereum",
  تتر: "tether",
  بایننسکوین: "binancecoin",
  ریپل: "ripple",
  کاردانو: "cardano",
  سولانا: "solana",
  دوجکوین: "dogecoin",
  ترون: "tron",
  آوالانچ: "avalanche-2",
  مونرو: "monero",
  چینلینک: "chainlink",
  تونکوین: "the-open-network",
  تون: "the-open-network",
  لایتکوین: "litecoin",
  پولکادات: "polkadot",
  شیبا: "shiba-inu",
  شیبااینو: "shiba-inu",
};

function normalizeFa(s: string) {
  return s
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\s]+/g, "");
}

// ---------- کیبوردهای داخل پیام ----------

const homeKb = new InlineKeyboard().text("🏠 منوی اصلی", "menu:home");

const pricesKb = new InlineKeyboard()
  .text("🔄 بروزرسانی", "prices:refresh")
  .row()
  .text("🏠 منوی اصلی", "menu:home");
const cancelStickerKb = new InlineKeyboard().text("❌ انصراف", "admin:sticker_cancel");

const newsCatKb = () => {
  const kb = new InlineKeyboard();
  for (const id of NEWS_CATEGORY_IDS) {
    kb.text(`${NEWS_CATEGORIES[id].emoji} ${NEWS_CATEGORIES[id].label}`, `news:cat:${id}`).row();
  }
  return kb.text("🏠 منوی اصلی", "menu:home");
};

const newsWinKb = (cat: string) =>
  new InlineKeyboard()
    .text(WINDOWS["1"].label, `news:win:${cat}:1`)
    .text(WINDOWS["3"].label, `news:win:${cat}:3`)
    .text(WINDOWS["24"].label, `news:win:${cat}:24`)
    .row()
    .text("⬅️ بازگشت", "menu:news");

const newsGoKb = (cat: string, win: string) =>
  new InlineKeyboard()
    .text("🔎 شروع جستجو", `news:go:${cat}:${win}`)
    .row()
    .text("⬅️ بازگشت", `news:cat:${cat}`);

const newsResultKb = (cat: string, win: string) =>
  new InlineKeyboard()
    .text("🔄 بروزرسانی", `news:go:${cat}:${win}`)
    .row()
    .text("📰 دسته‌ها", "menu:news")
    .text("🏠 منو", "menu:home");

const isWin = (w: string): w is WindowId => w in WINDOWS;

const backToSettingsKb = new InlineKeyboard().text("🔙 برگشت", "menu:settings");

/** دکمه‌های تنظیمات؛ فقط بعد از زدن «Setting» دیده می‌شوند و با «برگشت» از بین می‌روند */
function settingsKb(owner: boolean) {
  const kb = new InlineKeyboard().text("🎞 تنظیم استیکر فکرکردن", "admin:sticker").row();
  if (owner) kb.text("👥 فهرست ادمین‌ها", "admin:list").row();
  return kb.text("🔙 برگشت", "menu:home");
}

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

/** منوی اصلی؛ برای ادمین‌ها دکمه‌ی خبر و Setting هم دارد */
async function menuFor(ctx: Context) {
  const uid = ctx.from?.id;
  return mainMenu(!!uid && (await isAdminUser(uid)));
}

/** هر بار که کاربر در منو جابه‌جا می‌شود: ویس غیرفعال و حالت انتظار استیکر لغو می‌شود */
async function resetState(ctx: Context) {
  const uid = ctx.from?.id;
  if (!uid) return;
  await Promise.all([clearMode(uid), takePendingSticker(uid)]).catch((e) =>
    console.error("resetState error:", e)
  );
}

/** برای دکمه‌های مخصوص ادمین */
async function requireAdminCb(ctx: Context) {
  const uid = ctx.from?.id;
  if (uid && (await isAdminUser(uid))) return true;
  await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین", show_alert: true }).catch(() => {});
  return false;
}

async function sendPrices(ctx: Context) {
  await ctx.replyWithChatAction("typing");
  try {
    const { data, updatedAt } = await getPrices();
    await ctx.reply(formatPrices(data, updatedAt), { ...HTML, reply_markup: pricesKb });
  } catch {
    await ctx.reply("⚠️ الان نمی‌توانم اطلاعات را بگیرم. کمی بعد دوباره امتحان کن.");
  }
}

// ---------- منوی اصلی و کیبورد ثابت پایین ----------

async function showHome(ctx: Context) {
  await resetState(ctx);
  await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });

  // کیبورد پایین متناسب با وضعیت چت ناشناس کاربر
  const a = ctx.from ? await getAnon(ctx.from.id).catch(() => null) : null;
  const kb = a?.state === "chatting" ? chatKb : a?.state === "waiting" ? waitingKb : idleKb;
  await ctx.reply("👇 از دکمه‌های پایین هم می‌توانی استفاده کنی.", { reply_markup: kb });
}

// ---------- چت ناشناس ----------

async function startAnon(ctx: Context) {
  const uid = ctx.from!.id;
  await resetState(ctx); // ویس به متن / انتظار استیکر غیرفعال شود

  const r = await joinQueue(uid);

  if (r.status === "chatting") {
    return void (await ctx.reply("الان وسط چت هستی. برای پایان «🛑 پایان چت» را بزن.", {
      reply_markup: chatKb,
    }));
  }
  if (r.status === "waiting") {
    return void (await ctx.reply("🔎 دنبال یک نفر می‌گردم؛ تا پیدا شدن صبر کن...", {
      reply_markup: waitingKb,
    }));
  }

  // وصل شد: اول به طرف مقابل خبر بده؛ اگر ربات را بلاک کرده بود اتصال لغو می‌شود
  try {
    await ctx.api.sendMessage(r.partnerId, ANON_MATCHED, { reply_markup: chatKb });
  } catch {
    await leaveChat(uid);
    return void (await ctx.reply("😕 طرف مقابل در دسترس نبود. دوباره امتحان کن.", {
      reply_markup: idleKb,
    }));
  }
  await ctx.reply(ANON_MATCHED, { reply_markup: chatKb });
}

async function endAnon(ctx: Context) {
  const r = await leaveChat(ctx.from!.id);
  if (r.was === "chatting") {
    await ctx.reply("🛑 چت تمام شد.", { reply_markup: idleKb });
    if (r.partnerId) {
      await ctx.api
        .sendMessage(r.partnerId, "🛑 طرف مقابل چت را ترک کرد.", { reply_markup: idleKb })
        .catch(() => {});
    }
  } else if (r.was === "waiting") {
    await ctx.reply("جستجو لغو شد.", { reply_markup: idleKb });
  } else {
    await ctx.reply("الان چت فعالی نداری.", { reply_markup: idleKb });
  }
}

// ---------- ساخت ربات ----------

export function getBot() {
  if (_bot) return _bot;

  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN must be set");

  const bot = new Bot(token);

  // اول ضد تکرار، بعد بررسی کاربر
  bot.use(dedupeUpdates);
  bot.use(userGuard);

  // ================= خبر: فقط ادمین =================
  // قبل از همه‌ی handlerهای خبر می‌آید؛ برای غیرادمین جلوی ادامه را می‌گیرد
  bot.callbackQuery(/^(menu:news|news:)/, async (ctx, next) => {
    if (await isAdminUser(ctx.from.id)) return next();
    await ctx.answerCallbackQuery({
      text: "📰 این بخش فعلاً فقط برای ادمین‌هاست.",
      show_alert: true,
    });
  });

  // ================= دستورهای عمومی =================

  bot.command(["start", "menu"], showHome);

  bot.command("help", async (ctx) => {
    await resetState(ctx);
    const id = ctx.from?.id;
    let text = HELP_USER;
    if (id && (await isAdminUser(id))) text += "\n" + HELP_ADMIN;
    if (id && isOwner(id)) text += "\n" + HELP_OWNER;
    await ctx.reply(text, { ...HTML, reply_markup: homeKb });
  });

  bot.command("prices", async (ctx) => {
    await resetState(ctx);
    await sendPrices(ctx);
  });

  // ================= چت ناشناس =================

  // دکمه‌های کیبورد ثابت پایین
  bot.hears(BTN.connect, startAnon);
  bot.hears([BTN.cancel, BTN.end], endAnon);
  bot.command("end", endAnon);
  bot.hears(BTN.next, async (ctx) => {
    await endAnon(ctx);
    await startAnon(ctx);
  });
  bot.hears(BTN.menu, showHome);
  bot.hears(BTN.help, async (ctx) => {
    await resetState(ctx);
    await ctx.reply(HELP_USER, { ...HTML, reply_markup: homeKb });
  });

  // رد و بدل پیام بین دو نفر (متن، عکس، ویس، استیکر، ...).
  // باید قبل از handlerهای ویس/استیکر/متن بیاید.
  // copyMessage فرستنده را نشان نمی‌دهد (پیام «فوروارد‌شده» نیست).
  bot.on("message", async (ctx, next) => {
    if (ctx.message.text?.startsWith("/")) return next();

    const a = await getAnon(ctx.from.id);
    if (a?.state !== "chatting" || !a.partnerId) return next();

    try {
      await ctx.api.copyMessage(a.partnerId, ctx.chat.id, ctx.message.message_id);
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 403) {
        // طرف مقابل ربات را بلاک کرده
        await leaveChat(ctx.from.id);
        await ctx.reply("🛑 طرف مقابل در دسترس نیست؛ چت تمام شد.", { reply_markup: idleKb });
      } else {
        console.error("anon relay error:", e instanceof Error ? e.message : "unknown");
        await ctx.reply("⚠️ پیام ارسال نشد. دوباره بفرست.");
      }
    }
  });

  // ================= بخش ادمین =================

  // --- ورود به تنظیمات (فقط ادمین) ---
  bot.callbackQuery("menu:settings", async (ctx) => {
    if (!(await requireAdminCb(ctx))) return;
    await ctx.answerCallbackQuery();
    await resetState(ctx);
    await editOrReply(ctx, SETTINGS_TEXT, settingsKb(isOwner(ctx.from.id)));
  });

  // --- تنظیم استیکر فکرکردن ---
  bot.callbackQuery("admin:sticker", async (ctx) => {
    if (!(await requireAdminCb(ctx))) return;
    await ctx.answerCallbackQuery();

    const uid = ctx.from.id;
    await clearMode(uid);
    await setPendingSticker(uid);

    // اگر استیکری از قبل تنظیم شده، پیش‌نمایشش را نشان بده
    const current = await getThinkingSticker().catch(() => null);
    if (current) {
      await ctx.reply("استیکر فعلی:");
      await ctx.replyWithSticker(current).catch(() => {});
    } else {
      await ctx.reply("الان استیکری تنظیم نیست؛ به‌جایش 🔎 ارسال می‌شود.");
    }

    await ctx.reply("🎞 حالا استیکر جدید (ترجیحاً متحرک) را بفرست.", {
      reply_markup: cancelStickerKb,
    });
  });

  bot.callbackQuery("admin:sticker_cancel", async (ctx) => {
    if (!(await requireAdminCb(ctx))) return;
    await takePendingSticker(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    await editOrReply(ctx, SETTINGS_TEXT, settingsKb(isOwner(ctx.from.id)));
  });

  // --- دریافت استیکر (فقط وقتی ادمین در حالت انتظار است؛ بدون محدودیت زمانی) ---
  bot.on("message:sticker", async (ctx) => {
    const uid = ctx.from.id;
    if (!(await isAdminUser(uid))) return;
    if (!(await takePendingSticker(uid))) return;

    await setThinkingSticker(ctx.message.sticker.file_id);
    await ctx.reply(
      "✅ استیکر فکرکردن ذخیره شد. از این به بعد هنگام پردازش هوش مصنوعی نمایش داده می‌شود.",
      { reply_markup: settingsKb(isOwner(uid)) }
    );
  });

  // --- فهرست ادمین‌ها از داخل تنظیمات (فقط ادمین اصلی) ---
  bot.callbackQuery("admin:list", async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      return void (await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی", show_alert: true }));
    }
    await ctx.answerCallbackQuery();
    const list = await listAdmins();
    await editOrReply(
      ctx,
      [
        `👑 ادمین اصلی: ${ownerId()}`,
        "",
        ...(list.length ? list.map((a) => `▫️ ${a.userId}`) : ["ادمین فرعی‌ای وجود ندارد."]),
      ].join("\n"),
      backToSettingsKb
    );
  });

  // --- فقط ادمین اصلی (صاحب توکن): مدیریت ادمین‌های فرعی ---
  bot.command("addadmin", async (ctx) => {
    const owner = ctx.from?.id;
    if (!owner || !isOwner(owner)) return;

    const id = parseId(ctx.match);
    if (!id) return void (await ctx.reply("استفاده: /addadmin 123456789"));
    if (id === ownerId()) return void (await ctx.reply("تو ادمین اصلی هستی 👑"));

    await addAdmin(id, owner);

    // به ادمین جدید خبر بده (اگر قبلاً ربات را استارت کرده باشد)
    const notified = await ctx.api
      .sendMessage(id, "🛠 شما به‌عنوان ادمین ربات اضافه شدید. برای دیدن «⚙️ Setting» یک بار /start بزنید.")
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
    await ctx.api.sendMessage(id, "دسترسی ادمین شما برداشته شد.").catch(() => {});
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
    await resetState(ctx);
    await editOrReply(ctx, WELCOME, await menuFor(ctx));
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetState(ctx);
    await editOrReply(ctx, HELP_USER, homeKb);
  });

  // ================= قیمت‌ها =================

  bot.callbackQuery("menu:prices", async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetState(ctx);
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
        text: isNotModified(e) ? "آپدیت جدیدی نیست" : "⚠️ خطا در دریافت اطلاعات",
      });
    }
  });

  // ================= ویس به متن =================

  // فقط با زدن این دکمه فعال می‌شود؛ با «منوی اصلی» یا هر دکمه‌ی دیگر غیرفعال می‌شود
  bot.callbackQuery("menu:voice", async (ctx) => {
    await ctx.answerCallbackQuery();
    await takePendingSticker(ctx.from.id).catch(() => {});
    await setVoiceMode(ctx.from.id);
    await voiceGuide(ctx);
  });

  bot.on("message:voice", handleVoice);
  bot.on("message:audio", (ctx) =>
    ctx.reply("فعلاً فقط ویس تلگرام پشتیبانی می‌شود 🎙")
  );

  // ================= بخش‌های در دست ساخت =================
  // menu:news عمداً مستثنی است (handler خودش پایین‌تر است)
  bot.callbackQuery(/^menu:(?!news$)/, async (ctx) => {
    await resetState(ctx);
    await ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" });
  });

  // ================= خبر شخصی (فقط ادمین؛ گارد بالا) =================

  bot.callbackQuery("menu:news", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, "📰 <b>خبر شخصی</b>\nموضوع را انتخاب کن:", newsCatKb());
  });

  bot.callbackQuery(/^news:cat:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const cat = NEWS_CATEGORIES[ctx.match[1]];
    if (!cat) return;
    await editOrReply(ctx, `${cat.emoji} <b>${cat.label}</b>\nبازه‌ی زمانی را انتخاب کن:`, newsWinKb(cat.id));
  });

  bot.callbackQuery(/^news:win:(\w+):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, catId, win] = ctx.match;
    const cat = NEWS_CATEGORIES[catId];
    if (!cat || !isWin(win)) return;
    await editOrReply(
      ctx,
      `${cat.emoji} <b>${cat.label}</b> — ${WINDOWS[win].label}\nبرای شروع جستجو دکمه‌ی زیر را بزن.`,
      newsGoKb(cat.id, win)
    );
  });

  bot.callbackQuery(/^news:go:(\w+):(\w+)$/, async (ctx) => {
    const [, catId, win] = ctx.match;
    const cat = NEWS_CATEGORIES[catId];
    if (!cat || !isWin(win)) return void (await ctx.answerCallbackQuery());

    // سهمیه‌ی روزانه (ادمین‌ها معاف؛ چون این بخش فقط ادمین دارد، عملاً همیشه معاف است)
    const uid = ctx.from.id;
    let consumed = false;
    if (!(await isAdminUser(uid))) {
      const q = await consumeQuota(uid, "news");
      if (!q.allowed) {
        await ctx.answerCallbackQuery();
        return void (await ctx.reply(quotaExceededMessage("news"), HTML));
      }
      consumed = true;
    }
    const refund = async () => {
      if (consumed) await refundQuota(uid, "news").catch((e) => console.error("refund error:", e));
    };

    await ctx.answerCallbackQuery({ text: "در حال جستجو…" });
    await ctx.replyWithChatAction("typing");

    try {
      const r = await withThinking(ctx, () => getNews(cat.id, win));
      let text = formatNews(cat.id, win, r, r.updatedAt);
      if (text.length > 4000) text = text.slice(0, 3990).replace(/\n[^\n]*$/, "") + "\n…";
      await ctx.reply(text, { ...HTML, ...NO_PREVIEW, reply_markup: newsResultKb(cat.id, win) });
      // نتیجه‌ی خالی هم سهمیه را مصرف نمی‌کند
      if (r.items.length === 0) await refund();
    } catch (e) {
      await refund();
      if (e instanceof UserError) return void (await ctx.reply(e.message));
      console.error("news error:", e instanceof Error ? e.message : "unknown");
      await ctx.reply("⚠️ الان نمی‌توانم خبرها را بگیرم. کمی بعد دوباره امتحان کن.");
    }
  });

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
        text: isNotModified(e) ? "اپدیت جدیدی نیست" : "⚠️ خطا در دریافت اطلاعات",
      });
    }
  });

  // متن آزاد: نام یا نماد ارز (باید بعد از همه‌ی hears/commandها بیاید)
  bot.on("message:text", async (ctx) => {
    const raw = ctx.message.text.trim();
    // نام فارسی شناخته‌شده به شناسه‌ی CoinGecko تبدیل می‌شود
    const query = FA_COINS[normalizeFa(raw)] ?? raw;

    // فقط ورودی لاتین کوتاه (یا نام فارسی شناخته‌شده) را به‌عنوان ارز بررسی کن
    if (!SETTINGS.coinQueryPattern.test(query)) {
      return void (await ctx.reply("برای دیدن بخش‌ها /menu را بزن.", {
        reply_markup: await menuFor(ctx),
      }));
    }

    // سهمیه‌ی روزانه‌ی جستجوی ارز (ادمین‌ها معاف)
    const uid = ctx.from.id;
    let consumed = false;
    if (!(await isAdminUser(uid))) {
      const q = await consumeQuota(uid, "coin");
      if (!q.allowed) {
        return void (await ctx.reply(quotaExceededMessage("coin"), HTML));
      }
      consumed = true;
    }

    // اگر ارز پیدا نشد یا خطا شد، سهمیه برمی‌گردد
    const refund = async () => {
      if (consumed) await refundQuota(uid, "coin").catch((e) => console.error("refund error:", e));
    };

    await ctx.replyWithChatAction("typing");
    try {
      const coin = await findCoin(query);
      if (!coin) {
        await refund();
        return void (await ctx.reply("🔎 ارزی با این نام یا نماد پیدا نشد. یک بار دیگر امتحان کن.", {
          reply_markup: await menuFor(ctx),
        }));
      }
      await ctx.reply(formatCoin(coin), {
        ...HTML,
        ...NO_PREVIEW,
        reply_markup: coinKb(coin.id),
      });
    } catch (e) {
      console.error("coin lookup error:", e);
      await refund();
      await ctx.reply("⚠️ الان نمی‌توانم این ارز را بگیرم. کمی بعد دوباره امتحان کن.");
    }
  });

  bot.catch((err) => console.error("Bot error:", err));

  _bot = bot;
  return bot;
}