import { UserError } from "./errors";
import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

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
import { registerProfileEdit, clearEdit } from "./profileEdit";
import { SETTINGS, quotaExceededMessage } from "./config";
import { consumeQuota, refundQuota } from "./quota";
import { getPrices, formatPrices, findCoin, formatCoin } from "./prices";
import { dedupeUpdates, userGuard } from "./middleware";
import { mainMenu, BTN, idleKb, waitingKb, chatKb } from "./menu";
import { handleVoice, voiceGuide } from "./voice";
import { clearMode, setVoiceMode } from "./mode";
import {
  joinQueue,
  leaveChat,
  getAnon,
  cancelSearch,
  getChat,
  getChatByCode,
  logMessages,
  deleteChatMessages,
  MIN_CHAT_SEC,
} from "./anon";
import { NEWS_CATEGORIES, NEWS_CATEGORY_IDS, WINDOWS, type WindowId } from "./news/categories";
import { getNews, formatNews } from "./news";
import { getCoins, grantProfileReward } from "./coins";
import {
  ensurePublicId,
  getUserByPublicId,
  getUserRow,
  sendProfile,
  toggleSilent,
} from "./userProfile";
import { CHAT_INFO, COINS_INFO, PROFILE_INFO } from "./texts";
import {
  AGE_TEXT,
  BACK_TEXT,
  GENDER_TEXT,
  PROVINCE_TEXT,
  ageKb,
  provinceKb,
  genderKb,
  clearStep,
  getProfile,
  getStep,
  isProvince,
  missingStep,
  parseAge,
  saveAge,
  saveGender,
  saveProvince,
  setStep,
  type Gender,
} from "./profile";

let _bot: Bot | null = null;

// ---------- متن‌ها ----------

const RLM = "\u200F";

// اسمی که در پیام «پروفایلت دیده شد» نشان داده می‌شود؛ اسم ربات خودت را بگذار
const BOT_NAME = "ربات";

const WELCOME = "👋 <b>سلام!</b>\nیکی از بخش‌های زیر را انتخاب کن:";

// پیام /start برای کاربری که پروفایلش کامل است (همراه کیبورد ثابت پایین)
const START_TEXT =
  "خب ، حالا چه کاری برات انجام بدم؟\n<code>از منوی پایین👇 انتخاب کن</code>";

const SETTINGS_TEXT = "⚙️ <b>Setting</b>\nیکی از گزینه‌ها را انتخاب کن:";

const HELP_USER = [
  "ℹ️ <b>راهنما</b>",
  "",
  "▫️ /menu — منوی اصلی",
  "▫️ /prices — وضعیت بازار و ‌ها",
  "▫️ نام یا نماد هر ارز (مثل <code>btc</code> یا <code>solana</code> یا <code>بیت‌کوین</code>) را بفرست تا رمزارز را ببینی",
  "▫️ برای تبدیل ویس به متن، از منو «🎙 ویس به متن» را بزن و بعد ویس بفرست",
  "▫️ «💬 به یه ناشناس وصلم کن!» — چت ناشناس با یک نفر دیگر",
  "▫️ /end — پایان چت ناشناس",
  "",
  CHAT_INFO,
  "",
  PROFILE_INFO,
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

// پیام بعد از زدن «جستجوی شانسی»
const ANON_SEARCHING = [
  "🔎 درحال جستجوی مخاطب ناشناس شما",
  "🎲 جستوجوی شانسی",
  "",
  "⏳ حداکثر تا ۲ دقیقه صبر کنید.",
].join("\n");

// پیام بعد از اتصال (برای هر دو نفر)
const ANON_MATCHED = [
  "👀 پیدا کردم وصلتون کردم، به مخاطبت سلام کن 🗣",
  "<blockquote expandable>🚫 اخطار: به هیچ کاربری در ربات اعتماد نکنید و اطلاعات شخصیتان را در اختیارشان قرار ندهید",
  "",
  "⚠️ درصورتی که کاربر در اول چت از شما خواست به پی وی شخصی او بروید چت را قطع کرده و او را گزارش کنید!</blockquote>",
].join("\n");

const END_CONFIRM_TEXT = "🤖 پیام سیستم 👇\n\nمطمئنی میخوای چت رو قطع کنی؟";

// برای طرفی که پروفایلش دیده شده
const PROFILE_VIEWED = [
  "🤖 پیام سیستم 👇",
  "",
  `مخاطب شما 《 پروفایلِ ${BOT_NAME} 》 شما را مشاهده کرد.`,
  "",
  `<code>⚠️ توجه: پروفایلِ ${BOT_NAME} اطلاعاتی است که در بخش پروفایل ربات ثبت کرده اید!</code>`,
].join("\n");

// پیام قطع چت؛ byYou=false یعنی برای طرفی که چتش توسط مخاطب قطع شده
const endedText = (otherPublicId: string, code: string, byYou: boolean) =>
  [
    `${RLM}🎌 چت شما با /user_${otherPublicId} ${byYou ? "توسط شما" : "توسط مخاطب شما"} قطع شد.`,
    "",
    `${RLM}برای گزارش عدم رعایت قوانین (/ghavanin) می توانید با لمس 《 🚫 گزارش کاربر 》 در پروفایل، کاربر را گزارش کنید.`,
    "",
    `${RLM}🗑 برای حذف کل پیام های در چت هر دو طرف روی /delet_chat_${code} کلیک کنید!`,
    "",
    "<blockquote>⚠️ توجه: فقط پیام هایی که تا 48 ساعت پیش ارسال شده باشند حذف میشوند!</blockquote>",
  ].join("\n");

// پنل انتخاب نوع جستجو (بعد از زدن «به یه ناشناس وصلم کن!»)
const ANON_PICK_TEXT = [
  "\u200F لطفا قبل از شروع چت قوانین ربات « /ghavanin » را مطالعه و رعایت کنید.",
  "",
  "<blockquote expandable>\u200F⚠️ توجه داشته باشید که در بخش جستجوی شانسی بدلیل درخواست‌های زیاد احتمال اتصال به کاربر خانم بشدت پایینه!</blockquote>",
  "",
  "\u200F🫧 به کی وصلت کنم؟ <code>انتخاب کن</code> 👇",
].join("\n");

const RULES_TEXT = [
  "📜 <b>قوانین ربات</b>",
  "",
  "▫️ رعایت احترام الزامی است.",
  "▫️ ارسال محتوای نامناسب ممنوع است.",
].join("\n");

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

// دکمه‌ی شیشه‌ای زیر پیام جستجو
const cancelSearchKb = new InlineKeyboard().text("❌ لغو جستجو", "anon:cancel");

// ترتیب از چپ به راست: اتمام چت | ادامه چت
const endConfirmKb = new InlineKeyboard()
  .text("اتمام چت ❌", "anon:end")
  .text("ادامه چت 🗣", "anon:keep");

// ترتیب هر ردیف از چپ به راست است (چیدمان تلگرام)
const anonSearchKb: InlineKeyboardMarkup = {
  inline_keyboard: [
    [{ text: "🎲 جستجوی شانسی", callback_data: "anon:random", style: "primary" }],
    [
      { text: "👦 جستجوی پسر", callback_data: "anon:boy" },
      { text: "👧 جستجوی دختر", callback_data: "anon:girl" },
    ],
    [{ text: "📍 جستجوی اطراف", callback_data: "anon:nearby", style: "danger" }],
    [
      { text: "🎎 جستجوی هم استانی", callback_data: "anon:province" },
      { text: "👥 جستجوی هم سنی", callback_data: "anon:age" },
    ],
  ],
};

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

/** هر بار که کاربر در منو جابه‌جا می‌شود: ویس غیرفعال، حالت انتظار استیکر و مرحله‌ی نیمه‌کاره‌ی پروفایل لغو می‌شود */
async function resetState(ctx: Context) {
  const uid = ctx.from?.id;
  if (!uid) return;
  await Promise.all([clearMode(uid), takePendingSticker(uid), clearStep(uid), clearEdit(uid)]).catch((e) =>
    console.error("resetState error:", e)
  );
}

// ---------- تکمیل پروفایل (جنسیت ← سن ← استان) ----------

/** پیام مرحله‌ی مورد نظر را می‌فرستد */
async function askStep(ctx: Context, step: "gender" | "age" | "province", replyTo?: number) {
  const uid = ctx.from!.id;
  if (step === "gender") {
    await clearStep(uid);
    await ctx.reply(GENDER_TEXT, {
      reply_markup: genderKb,
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    });
  } else if (step === "age") {
    await setStep(uid, "age");
    await ctx.reply(AGE_TEXT, { ...HTML, reply_markup: ageKb() });
  } else {
    await setStep(uid, "province");
    await ctx.reply(PROVINCE_TEXT, { reply_markup: provinceKb() });
  }
}

/** اگر پروفایل کامل است true؛ وگرنه از اولین مرحله‌ی ناقص ادامه می‌دهد و false برمی‌گرداند */
async function ensureProfile(ctx: Context, notice = false) {
  const step = missingStep(await getProfile(ctx.from!.id));
  if (!step) return true;
  if (notice) await ctx.reply("⚠️ برای وصل شدن به ناشناس، اول باید پروفایلت را کامل کنی.");
  await askStep(ctx, step, ctx.message?.message_id);
  return false;
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

// ---------- شروع، منوی اصلی و کیبورد ثابت پایین ----------

/** کیبورد پایین متناسب با وضعیت چت ناشناس کاربر */
async function bottomKeyboardFor(ctx: Context) {
  const a = ctx.from ? await getAnon(ctx.from.id).catch(() => null) : null;
  return a?.state === "chatting" ? chatKb : a?.state === "waiting" ? waitingKb : idleKb;
}

/** /start: اگر پروفایل ناقص باشد جریان پروفایل شروع می‌شود؛ وگرنه یک پیام کوتاه همراه کیبورد ثابت پایین */
async function showStart(ctx: Context) {
  await resetState(ctx);
  if (!(await ensureProfile(ctx))) return;
  await ctx.reply(START_TEXT, { ...HTML, reply_markup: await bottomKeyboardFor(ctx) });
}

/** /menu و دکمه‌ی «📋 منو»: منوی اینلاین اصلی */
async function showHome(ctx: Context) {
  await resetState(ctx);
  await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
  await ctx.reply("👇 از دکمه‌های پایین هم می‌توانی استفاده کنی.", {
    reply_markup: await bottomKeyboardFor(ctx),
  });
}

// ---------- چت ناشناس ----------

/** با زدن «به یه ناشناس وصلم کن!»: پنل انتخاب نوع جستجو */
async function showAnonOptions(ctx: Context) {
  await resetState(ctx);
  const a = await getAnon(ctx.from!.id);

  if (a?.state === "chatting") {
    return void (await ctx.reply("الان وسط چت هستی. برای پایان «پایان چت» را بزن.", {
      reply_markup: chatKb,
    }));
  }
  if (a?.state === "waiting") {
    return void (await ctx.reply(ANON_SEARCHING, { reply_markup: cancelSearchKb }));
  }

  // بدون پروفایل کامل اجازه‌ی چت ناشناس نیست
  if (!(await ensureProfile(ctx, true))) return;

  await ctx.reply(ANON_PICK_TEXT, {
    ...HTML,
    ...NO_PREVIEW,
    // ریپلای روی پیام کاربر
    reply_parameters: { message_id: ctx.message!.message_id },
    reply_markup: anonSearchKb,
  });
}

/** ورود به صف و اتصال (جستجوی شانسی) */
async function startAnon(ctx: Context) {
  const uid = ctx.from!.id;
  await resetState(ctx); // ویس به متن / انتظار استیکر غیرفعال شود

  // بدون پروفایل کامل اجازه‌ی چت ناشناس نیست
  if (!(await ensureProfile(ctx, true))) return;

  const r = await joinQueue(uid);

  if (r.status === "chatting") {
    return void (await ctx.reply("الان وسط چت هستی. برای پایان «پایان چت» را بزن.", {
      reply_markup: chatKb,
    }));
  }
  if (r.status === "waiting") {
    return void (await ctx.reply(ANON_SEARCHING, { reply_markup: cancelSearchKb }));
  }

  // وصل شد: اول به طرف مقابل خبر بده؛ اگر ربات را بلاک کرده بود اتصال لغو می‌شود
  try {
    await ctx.api.sendMessage(r.partnerId, ANON_MATCHED, { ...HTML, reply_markup: chatKb });
  } catch {
    await leaveChat(uid);
    return void (await ctx.reply("😕 طرف مقابل در دسترس نبود. دوباره امتحان کن.", {
      reply_markup: idleKb,
    }));
  }
  await ctx.reply(ANON_MATCHED, { ...HTML, reply_markup: chatKb });
}

async function publicIdOf(userId: number) {
  const u = await getUserRow(userId);
  return ensurePublicId(userId, u?.publicId ?? null);
}

/** با زدن «پایان چت»: سؤال تأیید (ریپلای روی پیام کاربر) */
async function askEnd(ctx: Context) {
  const a = await getAnon(ctx.from!.id);
  if (a?.state !== "chatting") return endAnon(ctx); // در صف است یا چتی ندارد
  await ctx.reply(END_CONFIRM_TEXT, {
    ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
    reply_markup: endConfirmKb,
  });
}

/** پایان واقعی چت (یا لغو جستجو) */
async function endAnon(ctx: Context) {
  const uid = ctx.from!.id;
  const r = await leaveChat(uid);

  if (r.was === "waiting") {
    return void (await ctx.reply("جستجو لغو شد.", { reply_markup: idleKb }));
  }
  if (r.was === "none") {
    return void (await ctx.reply("الان چت فعالی نداری.", { reply_markup: idleKb }));
  }

  const chat = r.chatId ? await getChat(r.chatId) : null;
  if (!chat || !r.partnerId) {
    if (r.partnerId) {
      await ctx.api
        .sendMessage(r.partnerId, "🛑 طرف مقابل چت را ترک کرد.", { reply_markup: idleKb })
        .catch(() => {});
    }
    return void (await ctx.reply("🛑 چت تمام شد.", { reply_markup: idleKb }));
  }

  const [myPid, partnerPid] = await Promise.all([publicIdOf(uid), publicIdOf(r.partnerId)]);
  const opts = { ...HTML, ...NO_PREVIEW, reply_markup: idleKb };

  await ctx.reply(endedText(partnerPid, chat.code, true), opts);
  await ctx.api.sendMessage(r.partnerId, endedText(myPid, chat.code, false), opts).catch(() => {});
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

  bot.command("start", showStart);
  bot.command("menu", showHome);

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

  // متن قوانین را خودت عوض کن
  bot.command("ghavanin", async (ctx) => {
    await resetState(ctx);
    await ctx.reply(RULES_TEXT, HTML);
  });

  // تنظیم حالت سایلنت
  bot.command("silent", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const on = await toggleSilent(uid);
    if (on === null) return;
    await ctx.reply(on ? "🔕 حالت سایلنت روشن شد." : "🔔 حالت سایلنت خاموش شد.");
  });

  // ================= چت ناشناس =================

  // دکمه‌های کیبورد ثابت پایین
  bot.hears(BTN.connect, showAnonOptions);
  bot.hears(BTN.cancel, endAnon); // لغو جستجو (کیبورد قدیمی)
  bot.hears(BTN.end, askEnd); // «پایان چت» ← سؤال تأیید
  bot.command("end", askEnd);
  bot.hears(BTN.next, async (ctx) => {
    await endAnon(ctx);
    await startAnon(ctx);
  });

  // 👀 پروفایل مخاطب: پروفایل طرف مقابل برای من، و اعلان «پروفایلت دیده شد» برای او
  bot.hears(BTN.peer, async (ctx) => {
    const uid = ctx.from!.id;
    const a = await getAnon(uid);
    if (a?.state !== "chatting" || !a.partnerId) {
      return void (await ctx.reply("الان چت فعالی نداری.", { reply_markup: idleKb }));
    }
    const target = await getUserRow(a.partnerId);
    if (!target) return;
    await sendProfile(ctx, target, uid);
    await ctx.api.sendMessage(a.partnerId, PROFILE_VIEWED, HTML).catch(() => {});
  });

  // 🔒 چت ایمن (فعلاً بدون عملکرد)
  bot.hears(BTN.safe, async (ctx) => {
    await ctx.reply("این بخش به‌زودی فعال می‌شود 🚧");
  });

  // 🗑 حذف پیام‌های چت از هر دو طرف
  bot.hears(/^\/delet_chat_([a-z0-9]{5})$/, async (ctx) => {
    const uid = ctx.from!.id;
    const chat = await getChatByCode(ctx.match[1]);
    if (!chat || (chat.userA !== uid && chat.userB !== uid)) {
      return void (await ctx.reply("چتی با این کد پیدا نشد."));
    }
    if (!chat.endedAt) return void (await ctx.reply("این چت هنوز فعال است."));
    const n = await deleteChatMessages(ctx.api, chat.id);
    await ctx.reply(
      n > 0
        ? `🗑 پیام‌های چت از هر دو طرف حذف شد. (${n} پیام)`
        : "پیامی برای حذف باقی نمانده. (فقط پیام‌های ۴۸ ساعت اخیر حذف می‌شوند)"
    );
  });

  bot.hears(BTN.menu, showHome);
  bot.hears(BTN.help, async (ctx) => {
    await resetState(ctx);
    await ctx.reply(HELP_USER, { ...HTML, reply_markup: homeKb });
  });

  // 👤 پروفایل
  bot.hears(BTN.profile, async (ctx) => {
    await resetState(ctx);
    const uid = ctx.from!.id;
    const me = await getUserRow(uid);
    if (!me) return;
    if (missingStep(me)) {
      await ctx.reply("⚠️ اول باید پروفایلت را کامل کنی.");
      await ensureProfile(ctx);
      return;
    }
    await sendProfile(ctx, me, uid);
  });

  // 💰 سکه
  bot.hears(BTN.coins, async (ctx) => {
    await resetState(ctx);
    const coins = await getCoins(ctx.from!.id);
    await ctx.reply(`💰 <b>سکه‌های تو: ${coins}</b>\n\n${COINS_INFO}`, {
      ...HTML,
      ...NO_PREVIEW,
    });
  });

  // دیدن پروفایل با /user_xxxxxxxx
  bot.hears(/^\/user_([A-Za-z0-9]{8})$/, async (ctx) => {
    const target = await getUserByPublicId(ctx.match[1]);
    if (!target) return void (await ctx.reply("کاربری با این آیدی پیدا نشد."));
    await sendProfile(ctx, target, ctx.from!.id, await isAdminUser(ctx.from!.id));
  });

  // دکمه‌های کیبورد پایین که هنوز بخشی پشتشان نیست
  bot.hears([BTN.search, BTN.nearby, BTN.link, BTN.feedback], async (ctx) => {
    await resetState(ctx);
    await ctx.reply("این بخش به‌زودی فعال می‌شود 🚧");
  });

  // دکمه‌های اینلاین پروفایل که هنوز بخشی پشتشان نیست
  bot.callbackQuery(/^pf:(?!edit$)/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" });
  });

  // دکمه‌های اینلاین پنل جستجوی ناشناس
  bot.callbackQuery("anon:random", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await startAnon(ctx); // همان منطق صف قبلی
  });

  // ❌ لغو جستجو (دکمه‌ی شیشه‌ای زیر پیام جستجو)
  bot.callbackQuery("anon:cancel", async (ctx) => {
    const ok = await cancelSearch(ctx.from.id);
    await ctx.answerCallbackQuery(ok ? undefined : { text: "الان در حال جستجو نیستی." });
    await ctx.deleteMessage().catch(() => {});
    if (ok) await ctx.reply("جستجو لغو شد.", { reply_markup: idleKb });
  });

  // ادامه چت: فقط پیام تأیید پاک می‌شود
  bot.callbackQuery("anon:keep", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  // اتمام چت: قبل از ۱۰ ثانیه از شروع چت، خطا (alert) نشان داده می‌شود
  bot.callbackQuery("anon:end", async (ctx) => {
    const a = await getAnon(ctx.from.id);
    if (a?.state !== "chatting") {
      await ctx.answerCallbackQuery({ text: "الان چت فعالی نداری." });
      return void (await ctx.deleteMessage().catch(() => {}));
    }

    const chat = a.chatId ? await getChat(a.chatId) : null;
    if (chat) {
      const elapsed = (Date.now() - chat.startedAt.getTime()) / 1000;
      if (elapsed < MIN_CHAT_SEC) {
        const wait = Math.ceil(MIN_CHAT_SEC - elapsed);
        return void (await ctx.answerCallbackQuery({
          text: `⚠️ خطا: امکان پایان چت تا ${MIN_CHAT_SEC} ثانیه پس از وصل شدن ممکن نیست! لطفا ${wait} ثانیه دیگر برای پایان چت صبر کنید.`,
          show_alert: true,
        }));
      }
    }

    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await endAnon(ctx);
  });

  // این‌ها به اطلاعات پروفایل (جنسیت، سن، استان، موقعیت) نیاز دارند
  bot.callbackQuery(/^anon:(boy|girl|nearby|province|age)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" });
  });

  // رد و بدل پیام بین دو نفر (متن، عکس، ویس، استیکر، ...).
  // باید قبل از handlerهای ویس/استیکر/متن بیاید.
  // copyMessage فرستنده را نشان نمی‌دهد (پیام «فوروارد‌شده» نیست).
  bot.on("message", async (ctx, next) => {
    if (ctx.message.text?.startsWith("/")) return next();

    const a = await getAnon(ctx.from.id);
    if (a?.state !== "chatting" || !a.partnerId) return next();

    try {
      const sent = await ctx.api.copyMessage(a.partnerId, ctx.chat.id, ctx.message.message_id);
      // آیدی پیام‌ها برای «حذف پیام‌ها از هر دو طرف» ذخیره می‌شود
      if (a.chatId) {
        await logMessages(a.chatId, [
          { userId: ctx.from.id, messageId: ctx.message.message_id },
          { userId: a.partnerId, messageId: sent.message_id },
        ]).catch((e) => console.error("logMessages error:", e));
      }
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

  registerProfileEdit(bot);

  // ================= تکمیل پروفایل =================

  // مرحله‌ی ۱: جنسیت (دکمه‌ی اینلاین)
  bot.callbackQuery(/^profile:gender:(m|f)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await saveGender(ctx.from.id, ctx.match[1] as Gender);
    await ctx.deleteMessage().catch(() => {});
    await askStep(ctx, "age");
  });

  // مرحله‌ی ۲ و ۳: سن و استان (متن یا دکمه‌ی کیبورد پایین)
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();

    const step = await getStep(ctx.from.id);
    if (!step) return next();
    const uid = ctx.from.id;

    if (step === "age") {
      const age = parseAge(text);
      if (age === null) {
        return void (await ctx.reply("⚠️ سن باید یک عدد بین ۹ تا ۹۹ باشد. (برای خروج /menu)"));
      }
      await saveAge(uid, age);
      return void (await askStep(ctx, "province"));
    }

    // step === "province"
    if (text === BACK_TEXT) return void (await askStep(ctx, "age"));
    if (!isProvince(text)) {
      return void (await ctx.reply("لطفا استان را از لیست پایین انتخاب کن 👇"));
    }
    await saveProvince(uid, text);
    await clearStep(uid);

    // هدیه‌ی تکمیل پروفایل (فقط یک بار)
    const reward = await grantProfileReward(uid).catch((e) => {
      console.error("profile reward error:", e);
      return null;
    });
    await ctx.reply(
      "✅ پروفایلت کامل شد!" +
        (reward ? `\n🎁 ${reward} سکه هدیه گرفتی.` : "") +
        "\nحالا می‌تونی «💬 به یه ناشناس وصلم کن!» رو بزنی.",
      { reply_markup: idleKb }
    );
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