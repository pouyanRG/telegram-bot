import { UserError } from "./errors";
import {
  beginNewsCategoryDraft,
  formatNewsItem,
  getNewsAlertsEnabled,
  getNewsCategoryDraft,
  getNewsFeed,
  getNewsSelection,
  getNewsUserState,
  markNewsRead,
  setNewsAlertsEnabled,
  setNewsSelection,
  toggleNewsFavorite,
  toggleNewsCategoryDraft,
  type NewsCategory,
  type NewsFeed,
  type NewsStory,
} from "./news";
import { Bot, GrammyError, InlineKeyboard, Keyboard, type Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { checkRate, shouldWarn } from "./rateLimit";
import { registerReports, clearReport, takePendingDefPhoto } from "./reports";
import { sendPeerProfile } from "./peerProfile";
import { registerProfileEdit, clearEdit } from "./profileEdit";
import {
  ANONYMOUS_FEATURES_ENABLED,
  SETTINGS,
  COINS,
  quotaExceededMessage,
} from "./config";
import { registerAnonLink, handleStartPayload, sendMyLink, clearDmState } from "./anonLink";
import { consumeQuota, refundQuota } from "./quota";
import { getPrices, formatPrices, findCoin, formatCoin } from "./prices";
import { dedupeUpdates, userGuard, throttle } from "./middleware";
import { mainMenu, BTN, idleKb, waitingKb, chatKb } from "./menu";
import { handleVoice, voiceGuide } from "./voice";
import { clearMode, setVoiceMode } from "./mode";
import { getCoins, grantProfileReward } from "./coins";
import { CHAT_INFO, COINS_INFO, PROFILE_INFO } from "./texts";
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
  RANDOM,
  type SearchOpts,
} from "./anon";

import {
  ensurePublicId,
  getUserByPublicId,
  getUserRow,
  sendProfile,
  toggleSilent,
} from "./userProfile";
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

const DISABLED_ANON_BUTTONS = new Set([
  BTN.connect, BTN.search, BTN.nearby, BTN.link,
  BTN.cancel, BTN.end, BTN.next, BTN.peer, BTN.safe,
]);

const WELCOME =
  "👋 <b>سلام!</b>\nاز منوی زیر انتخاب کن از کدام بخش می‌خواهی استفاده کنی:";

const SETTINGS_TEXT = "⚙️ <b>تنظیمات</b>\nیکی از گزینه‌ها را انتخاب کن:";

const HELP_USER = [
  "ℹ️ <b>راهنما</b>",
  "",
  "▫️ /menu — منوی اصلی",
  "▫️ /prices — وضعیت بازار و ‌ها",
  "▫️ نام یا نماد هر ارز (مثل <code>btc</code> یا <code>solana</code> یا <code>بیت‌کوین</code>) را بفرست تا رمزارز را ببینی",
  "▫️ برای تبدیل ویس به متن، از منو «🎙 ویس به متن» را بزن و بعد ویس بفرست",
  "▫️ از منوی اصلی «📰 اخبار روز» را بزن، دسته‌های دلخواهت را انتخاب کن و خبرها را بخوان",
  ...(ANONYMOUS_FEATURES_ENABLED
    ? [
        "▫️ از منوی اصلی «💬 چت ناشناس» را انتخاب کن تا نوع جستجو را مشخص کنی",
        "▫️ /end — پایان چت ناشناس",
        CHAT_INFO,
      ]
    : []),
  "",
  PROFILE_INFO,
  "",
  "<i>ربات در حال توسعه است و بخش‌ها به‌تدریج فعال می‌شوند.</i>",
].join("\n");

const HELP_ADMIN = [
  "",
  "🛠 <b>بخش ادمین</b>",
  "▫️ منو ← «⚙️ تنظیمات» — تنظیمات ادمین (مثل استیکر فکرکردن)",
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
    [{ text: "⬅️ بازگشت به منوی اصلی", callback_data: "menu:home" }],
  ],
};

function newsHomeKb() {
  const kb = new InlineKeyboard();
  return kb
    .text("📰 مشاهده همه", "news:show")
    .text("🆕 خبرهای جدید", "news:unread")
    .row()
    .text("📚 خوانده‌شده‌ها", "news:history")
    .text("⚙️ تنظیمات", "news:settings");
}

function newsSettingsKb(alertsEnabled: boolean) {
  return new InlineKeyboard()
    .text("🏷 دسته‌بندی‌ها", "news:categories")
    .row()
    .text(`${alertsEnabled ? "🔔" : "🔕"} ارسال خودکار: ${alertsEnabled ? "فعال" : "غیرفعال"}`, "news:alerts")
    .row()
    .text("⬅️ بازگشت", "menu:news");
}

function newsCategoriesKb(categories: NewsCategory[], selected: string[]) {
  const kb = new InlineKeyboard();
  const active = new Set(selected);
  for (const category of categories) {
    const mark = active.has(category.id) ? "✅" : "▫️";
    const label = Array.from(category.label).slice(0, 28).join("");
    kb.text(`${mark} ${label} (${category.count.toLocaleString("fa-IR")})`, `news:toggle:${category.id}`).row();
  }
  return kb
    .text("💾 ثبت تغییرات", "news:categories:save")
    .text("↩️ لغو", "news:categories:cancel")
    .row();
}

function newsHomeText() {
  return "📰 <b>اخبار روز</b>\nیکی از گزینه‌های زیر را انتخاب کن:";
}

function newsSettingsText(alertsEnabled: boolean) {
  return [
    "⚙️ <b>تنظیمات اخبار</b>",
    `ارسال خودکار خبرهای جدید: <b>${alertsEnabled ? "فعال" : "غیرفعال"}</b>`,
    "دسته‌بندی‌ها را انتخاب کن یا وضعیت ارسال خودکار را تغییر بده.",
  ].join("\n");
}

function newsCategoriesText(selectedCount: number, total: number) {
  return [
    "🏷 <b>دسته‌بندی خبرها</b>",
    "دسته‌های موردنظرت را انتخاب کن و در پایان «ثبت تغییرات» را بزن.",
    `انتخاب‌شده: ${selectedCount.toLocaleString("fa-IR")} از ${total.toLocaleString("fa-IR")}`,
  ].join("\n");
}

function newsCardKeyboard(index: number, total: number, storyId: string, isFavorite: boolean) {
  const kb = new InlineKeyboard();
  if (index > 0) kb.text("⬅️ قبلی", `news:view:${index - 1}`);
  if (index + 1 < total) kb.text("بعدی ➡️", `news:view:${index + 1}`);
  if (index > 0 || index + 1 < total) kb.row();
  kb.text(isFavorite ? "⭐ ذخیره‌شده" : "☆ ذخیره خبر", `news:favorite:${storyId}`)
    .row()
    .text("⭐ ذخیره‌ها", "news:favorites")
    .row()
    .text("⚙️ تنظیمات", "news:settings")
    .text("🏠 منو", "menu:home");
  return kb;
}

const backToSettingsKb = new InlineKeyboard().text("🔙 برگشت", "menu:settings");

/** دکمه‌های تنظیمات؛ فقط بعد از زدن «Setting» دیده می‌شوند و با «برگشت» از بین می‌روند */
function settingsKb(owner: boolean) {
  const kb = new InlineKeyboard().text("🎞 تنظیم استیکر فکرکردن", "admin:sticker").row();
  kb.text("🚨 گزارش‌ها", "admin:reports").row();
  kb.text("🖼 عکس پیش‌فرض پسر", "admin:defphoto:m").text("🖼 عکس پیش‌فرض دختر", "admin:defphoto:f").row();
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

/** منوی اصلی؛ گزینه‌های مدیریتی فقط برای ادمین‌ها نمایش داده می‌شوند */
async function menuFor(ctx: Context) {
  const uid = ctx.from?.id;
  return mainMenu(!!uid && (await isAdminUser(uid)));
}

async function stopDisabledAnonSession(userId: number, ctx: Context) {
  if (!(await getAnon(userId))) return;
  const result = await leaveChat(userId);
  if (result.was === "chatting" && result.partnerId) {
    await ctx.api
      .sendMessage(result.partnerId, "این بخش فعلاً در دسترس نیست.", { reply_markup: idleKb })
      .catch((error) =>
        console.warn("disabled chat partner notification failed:", error instanceof Error ? error.message : "unknown")
      );
  }
}

/** هر بار که کاربر در منو جابه‌جا می‌شود: ویس غیرفعال، حالت انتظار استیکر و مرحله‌ی نیمه‌کاره‌ی پروفایل لغو می‌شود */
async function resetState(ctx: Context) {
  const uid = ctx.from?.id;
  if (!uid) return;
  await Promise.all([
    clearMode(uid), takePendingSticker(uid), clearStep(uid), clearEdit(uid),
    clearReport(uid), takePendingDefPhoto(uid), clearDmState(uid),
    ...(ANONYMOUS_FEATURES_ENABLED ? [] : [stopDisabledAnonSession(uid, ctx)]),
  ]).catch((e) => console.error("resetState error:", e));
}

async function clearLegacyReplyKeyboard(ctx: Context) {
  await ctx.reply("✅ منو به‌روز شد.", { reply_markup: { remove_keyboard: true } });
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

async function renderNewsScreen(ctx: Context, text: string, keyboard: InlineKeyboard) {
  const message = ctx.callbackQuery?.message;
  if (message && "photo" in message && message.photo?.length) {
    await ctx.deleteMessage();
    await ctx.reply(text, { ...HTML, reply_markup: keyboard });
    return;
  }
  await editOrReply(ctx, text, keyboard);
}

async function renderNewsHome(ctx: Context) {
  await renderNewsScreen(ctx, newsHomeText(), newsHomeKb());
}

async function renderNewsSettings(ctx: Context) {
  const alertsEnabled = await getNewsAlertsEnabled(ctx.from!.id);
  await renderNewsScreen(ctx, newsSettingsText(alertsEnabled), newsSettingsKb(alertsEnabled));
}

async function renderNewsCategories(ctx: Context, feed: NewsFeed) {
  const selected = await getNewsCategoryDraft(ctx.from!.id, feed.categories);
  await renderNewsScreen(
    ctx,
    newsCategoriesText(selected.length, feed.categories.length),
    newsCategoriesKb(feed.categories, selected)
  );
}

async function showNewsList(ctx: Context, title: string, stories: NewsStory[]) {
  if (!stories.length) {
    await editOrReply(
      ctx,
      `${title}\n\nفعلاً خبری در این فهرست نیست.`,
      new InlineKeyboard().text("⚙️ تنظیمات", "news:settings").text("🏠 اخبار روز", "menu:news")
    );
    return;
  }

  const visibleStories = stories.slice(0, 12);
  const storyLines = visibleStories.map((story, index) => {
    const characters = Array.from(story.title);
    const title = characters.slice(0, 160).join("");
    const safeTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const number = (index + 1).toLocaleString("fa-IR");
    return `${number}. ${safeTitle}${characters.length > 160 ? "…" : ""}`;
  });
  const keyboard = new InlineKeyboard();
  visibleStories.forEach((story, index) => {
    keyboard.text(`📰 ${(index + 1).toLocaleString("fa-IR")}`, `news:open:${story.id}`);
    if ((index + 1) % 3 === 0) keyboard.row();
  });
  if (visibleStories.length % 3 !== 0) keyboard.row();
  keyboard.text("⚙️ تنظیمات", "news:settings").text("🏠 اخبار روز", "menu:news");
  await editOrReply(ctx, `${title}\n\n${storyLines.join("\n")}`, keyboard);
}

async function reportNewsError(ctx: Context, error: unknown) {
  if (error instanceof UserError) {
    await ctx.reply(error.message);
    return;
  }
  console.error("news error:", error instanceof Error ? error.message : "unknown");
  await ctx.reply("⚠️ الان نمی‌توانم فید خبر را دریافت کنم. کمی بعد دوباره امتحان کن.");
}

async function showNewsCard(
  ctx: Context,
  feed: NewsFeed,
  stories: NewsStory[],
  index: number
) {
  const story = stories[index];
  if (!story) return;
  const body = formatNewsItem(story, index, stories.length);
  const caption = feed.stale
    ? `${body}\n\n⚠️ فید موقتاً به‌روز نشد؛ این خبر از نسخهٔ ذخیره‌شده است.`
    : body;
  const userId = ctx.from!.id;
  const state = await getNewsUserState(userId);
  const keyboard = newsCardKeyboard(index, stories.length, story.id, state.favoriteIds.includes(story.id));
  const message = ctx.callbackQuery?.message;
  const hasPhoto = !!message && "photo" in message && !!message.photo?.length;

  if (!message) {
    await sendNewsCard(ctx, story, caption, keyboard);
  } else if (hasPhoto && story.imageUrl) {
    try {
      await ctx.editMessageMedia(
        { type: "photo", media: story.imageUrl, caption, parse_mode: "HTML" },
        { reply_markup: keyboard }
      );
    } catch (error) {
      console.warn("news image edit failed:", error instanceof Error ? error.message : "unknown");
      await ctx.deleteMessage();
      await ctx.reply(caption, { ...HTML, reply_markup: keyboard });
    }
  } else if (!hasPhoto && !story.imageUrl) {
    await editOrReply(ctx, caption, keyboard);
  } else {
    await ctx.deleteMessage();
    await sendNewsCard(ctx, story, caption, keyboard);
  }
  await markNewsRead(userId, story.id);
}

async function sendNewsCard(
  ctx: Context,
  story: NewsStory,
  caption: string,
  keyboard: InlineKeyboard
) {
  if (story.imageUrl) {
    try {
      await ctx.replyWithPhoto(story.imageUrl, {
        caption,
        ...HTML,
        reply_markup: keyboard,
      });
      return;
    } catch (error) {
      console.warn("news image send failed:", error instanceof Error ? error.message : "unknown");
    }
  }
  await ctx.reply(caption, { ...HTML, reply_markup: keyboard });
}

// ---------- شروع، منوی اصلی و کیبورد ثابت پایین ----------

/** کیبورد پایین متناسب با وضعیت چت ناشناس کاربر */
async function bottomKeyboardFor(ctx: Context) {
  const a = ctx.from ? await getAnon(ctx.from.id).catch(() => null) : null;
  return a?.state === "chatting" ? chatKb : a?.state === "waiting" ? waitingKb : idleKb;
}

/** /menu و دکمه‌ی «📋 منو»: منوی اینلاین اصلی */
async function showHome(ctx: Context) {
  await resetState(ctx);
  await clearLegacyReplyKeyboard(ctx);
  await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
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
    ...(ctx.message?.message_id
      ? { reply_parameters: { message_id: ctx.message.message_id } }
      : {}),
    reply_markup: anonSearchKb,
  });
}


const searchLabel = (o: SearchOpts) => {
  const g =
    o.gender === "m" ? "👦 جستجوی پسر" : o.gender === "f" ? "👧 جستجوی دختر" : "🎲 جستجوی شانسی";
  const s = o.scope === "province" ? "🎎 هم استانی" : o.scope === "age" ? "👥 هم سنی" : null;
  return s ? `${s} — ${g}` : g;
};

const searchingText = (o: SearchOpts) =>
  ["🔎 درحال جستجوی مخاطب ناشناس شما", searchLabel(o), "", "⏳ حداکثر تا ۲ دقیقه صبر کنید."].join("\n");

const noCoinsText = `💰 برای جستجو بر اساس جنسیت ${COINS.genderSearch} سکه لازم است و موجودی کافی نداری.\n<blockquote>سکه فقط وقتی کسر می‌شود که به کسی وصل شوی.</blockquote>`;

/** ورود به صف و اتصال */
async function startAnon(ctx: Context, opts: SearchOpts = RANDOM) {
  const uid = ctx.from!.id;
  await resetState(ctx);

  if (!(await ensureProfile(ctx, true))) return;

  if (opts.gender && (await getCoins(uid)) < COINS.genderSearch) {
    return void (await ctx.reply(noCoinsText, { ...HTML, reply_markup: idleKb }));
  }

  const r = await joinQueue(uid, opts);

  if (r.status === "noprofile") {
    await ensureProfile(ctx);
    return;
  }
  if (r.status === "nocoins") {
    return void (await ctx.reply(noCoinsText, { ...HTML, reply_markup: idleKb }));
  }
  if (r.status === "chatting") {
    return void (await ctx.reply("الان وسط چت هستی. برای پایان «پایان چت» را بزن.", {
      reply_markup: chatKb,
    }));
  }
  if (r.status === "waiting") {
    return void (await ctx.reply(searchingText(opts), { reply_markup: cancelSearchKb }));
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
  if (opts.gender) {
    await ctx.reply(
      `💰 ${COINS.genderSearch} سکه کسر شد. اگر چت زیر ۱ دقیقه تمام شود ${COINS.shortChatRefund} سکه برمی‌گردد.`
    );
  }
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
  const note = `↩️ چت زیر ۱ دقیقه تمام شد؛ ${COINS.shortChatRefund} سکه به حسابت برگشت.`;
  if (r.refunded.includes(uid)) await ctx.reply(note).catch(() => {});
  if (r.refunded.includes(r.partnerId)) await ctx.api.sendMessage(r.partnerId, note).catch(() => {});
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
  bot.use(throttle);
  bot.use(async (ctx, next) => {
    if (ANONYMOUS_FEATURES_ENABLED) return next();

    if (ctx.callbackQuery && ctx.from) {
      await stopDisabledAnonSession(ctx.from.id, ctx);
    }

    const callback = ctx.callbackQuery?.data;
    if (
      callback &&
      (callback === "menu:anon" || /^(anon:|dm:|pp:(?:dm|chat|notify):)/.test(callback))
    ) {
      await ctx.answerCallbackQuery({ text: "این بخش فعلاً در دسترس نیست." }).catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      await clearLegacyReplyKeyboard(ctx);
      await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
      return;
    }

    const input = ctx.message?.text?.trim();
    if (
      input &&
      (DISABLED_ANON_BUTTONS.has(input) ||
        /^\/(?:end|delet_chat_[a-z0-9]{5})(?:@\w+)?(?:\s|$)/i.test(input))
    ) {
      await stopDisabledAnonSession(ctx.from!.id, ctx);
      await ctx.reply("این گزینه در منوی فعلی وجود ندارد.", { reply_markup: idleKb });
      return;
    }
    await next();
  });

  // ================= دستورهای عمومی =================

  bot.command("start", async (ctx) => {
    await resetState(ctx);
    if (ANONYMOUS_FEATURES_ENABLED && (await handleStartPayload(ctx))) return;
    await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
  });

  bot.command("menu", showHome);

  bot.command("help", async (ctx) => {
    await resetState(ctx);
    await clearLegacyReplyKeyboard(ctx);
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
    await sendPeerProfile(ctx, target, uid, await isAdminUser(uid));
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
    await clearLegacyReplyKeyboard(ctx);
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
    const viewer = ctx.from!.id;
    await sendPeerProfile(ctx, target, viewer, await isAdminUser(viewer));
  });


  if (ANONYMOUS_FEATURES_ENABLED) {
    bot.hears(BTN.link, async (ctx) => {
      await resetState(ctx);
      await sendMyLink(ctx);
    });
  }

  // دکمه‌های کیبورد پایین که هنوز بخشی پشتشان نیست
  bot.hears([BTN.search, BTN.nearby, BTN.feedback], async (ctx) => {
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


  // جستجوی پسر / دختر (۲ سکه، فقط هنگام اتصال)
  bot.callbackQuery(/^anon:(boy|girl)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await startAnon(ctx, { scope: null, gender: ctx.match[1] === "boy" ? "m" : "f" });
  });

  // پنل دوم: هم‌استانی / هم‌سنی (شانسی رایگان، پسر/دختر ۲ سکه)
  const subPanelKb = (k: "p" | "a") =>
    new InlineKeyboard()
      .text("🎲 جستجوی شانسی", `anon:${k}:r`)
      .row()
      .text("👱‍♂️ جستجوی پسر", `anon:${k}:b`)
      .text("👩‍🦰 جستجوی دختر", `anon:${k}:g`);

  bot.callbackQuery(/^anon:(province|age)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const k = ctx.match[1] === "age" ? "a" : "p";
    const who = k === "a" ? "هم سنی" : "هم استانی";
    await editOrReply(
      ctx,
      `چه کسی رو از ${who} هات پیدا کنم؟ <code>انتخاب کن</code>👇`,
      subPanelKb(k)
    );
  });

  bot.callbackQuery(/^anon:(p|a):(r|b|g)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    const [, k, g] = ctx.match;
    await startAnon(ctx, {
      scope: k === "p" ? "province" : "age",
      gender: g === "b" ? "m" : g === "g" ? "f" : null,
    });
  });

  bot.callbackQuery("anon:nearby", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" });
  });

  // رد و بدل پیام بین دو نفر (متن، عکس، ویس، استیکر، ...).
  // باید قبل از handlerهای ویس/استیکر/متن بیاید.
  // copyMessage فرستنده را نشان نمی‌دهد (پیام «فوروارد‌شده» نیست).
 
bot.on("message", async (ctx, next) => {
  if (ctx.message.text?.startsWith("/")) return next();

  const a = await getAnon(ctx.from.id);
  if (!ANONYMOUS_FEATURES_ENABLED && a) {
    const result = await leaveChat(ctx.from.id);
    if (result.was === "chatting" && result.partnerId) {
      await ctx.api
        .sendMessage(result.partnerId, "این بخش فعلاً در دسترس نیست.", { reply_markup: idleKb })
        .catch((error) =>
          console.warn("disabled chat partner notification failed:", error instanceof Error ? error.message : "unknown")
        );
    }
    await ctx.reply("این بخش فعلاً در دسترس نیست.", { reply_markup: idleKb });
    return;
  }
  if (a?.state !== "chatting" || !a.partnerId) return next();

  // محدودیت سخت‌گیرانه برای ارسال پیام به طرف مقابل
  if (!(await checkRate("relay", ctx.from.id))) {
    if (await shouldWarn(ctx.from.id)) {
      await ctx.reply(
        "⏳ پیام‌هایت خیلی سریع است؛ این پیام ارسال نشد."
      ).catch(() => {});
    }
    return;
  }

  try {
    const sent = await ctx.api.copyMessage(
      a.partnerId,
      ctx.chat.id,
      ctx.message.message_id
    );

    // ذخیره آیدی پیام‌ها برای حذف پیام‌ها از هر دو طرف
    if (a.chatId) {
      await logMessages(a.chatId, [
        { userId: ctx.from.id, messageId: ctx.message.message_id, fromId: ctx.from.id },
        { userId: a.partnerId, messageId: sent.message_id, fromId: ctx.from.id },
      ]).catch((e) => console.error("logMessages error:", e));
    }
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 403) {
      // طرف مقابل ربات را بلاک کرده
      await leaveChat(ctx.from.id);
      await ctx.reply(
        "🛑 طرف مقابل در دسترس نیست؛ چت تمام شد.",
        { reply_markup: idleKb }
      );
    } else {
      console.error(
        "anon relay error:",
        e instanceof Error ? e.message : "unknown"
      );
      await ctx.reply("⚠️ پیام ارسال نشد. دوباره بفرست.");
    }
  }
});

if (ANONYMOUS_FEATURES_ENABLED) registerAnonLink(bot);
registerProfileEdit(bot);
registerReports(bot);

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
        (ANONYMOUS_FEATURES_ENABLED
          ? "\nحالا می‌تونی «💬 به یه ناشناس وصلم کن!» رو بزنی."
          : ""),
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
      .sendMessage(id, "🛠 شما به‌عنوان ادمین ربات اضافه شدید. برای دیدن «⚙️ تنظیمات» یک بار /start بزنید.")
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
    await clearLegacyReplyKeyboard(ctx);
    const message = ctx.callbackQuery.message;
    if (message && "photo" in message && message.photo?.length) {
      await ctx.deleteMessage();
      await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
      return;
    }
    await editOrReply(ctx, WELCOME, await menuFor(ctx));
  });

  if (ANONYMOUS_FEATURES_ENABLED) {
    bot.callbackQuery("menu:anon", async (ctx) => {
      await ctx.answerCallbackQuery();
      await showAnonOptions(ctx);
    });
  }

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetState(ctx);
    await clearLegacyReplyKeyboard(ctx);
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

  // ================= خبر شخصی از RSS =================

  bot.callbackQuery("menu:news", async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetState(ctx);
    await renderNewsHome(ctx);
  });

  bot.callbackQuery("news:settings", async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderNewsSettings(ctx);
  });

  bot.callbackQuery("news:categories", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      await beginNewsCategoryDraft(ctx.from.id, feed.categories);
      await renderNewsCategories(ctx, feed);
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:toggle:([a-f0-9]{12})$/, async (ctx) => {
    try {
      const feed = await getNewsFeed();
      await toggleNewsCategoryDraft(ctx.from.id, ctx.match[1], feed.categories);
      await ctx.answerCallbackQuery();
      await renderNewsCategories(ctx, feed);
    } catch (error) {
      await ctx.answerCallbackQuery().catch(() => {});
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:(?:all|show)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "دریافت خبرها…" });
    try {
      const feed = await getNewsFeed();
      if (!feed.stories.length) {
        await renderNewsScreen(
          ctx,
          "فعلاً خبری در فید موجود نیست.",
          new InlineKeyboard().text("⬅️ بازگشت", "menu:news")
        );
        return;
      }
      await showNewsCard(ctx, feed, feed.stories, 0);
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:categories:save", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      const selected = await getNewsCategoryDraft(ctx.from.id, feed.categories);
      await setNewsSelection(ctx.from.id, selected, feed.categories);
      await renderNewsSettings(ctx);
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:categories:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      const selected = await getNewsSelection(ctx.from.id, feed.categories);
      await setNewsSelection(ctx.from.id, selected, feed.categories);
      await renderNewsSettings(ctx);
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:unread", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      const selected = new Set(await getNewsSelection(ctx.from.id, feed.categories));
      const state = await getNewsUserState(ctx.from.id);
      if (!selected.size) {
        await renderNewsSettings(ctx);
        return;
      }
      const stories = feed.stories.filter(
        (story) => selected.has(story.categoryId) && !state.readIds.includes(story.id)
      );
      await showNewsList(ctx, "🆕 <b>خبرهای جدید و خوانده‌نشده</b>", stories);
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:favorites", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const [feed, state] = await Promise.all([getNewsFeed(), getNewsUserState(ctx.from.id)]);
      await showNewsList(
        ctx,
        "⭐ <b>خبرهای ذخیره‌شده</b>",
        feed.stories.filter((story) => state.favoriteIds.includes(story.id))
      );
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const [feed, state] = await Promise.all([getNewsFeed(), getNewsUserState(ctx.from.id)]);
      await showNewsList(
        ctx,
        "📚 <b>خبرهای خوانده‌شده</b>",
        feed.stories.filter((story) => state.readIds.includes(story.id))
      );
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:open:([a-f0-9]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      const story = feed.stories.find((item) => item.id === ctx.match[1]);
      if (!story) {
        await renderNewsHome(ctx);
        return;
      }
      await showNewsCard(ctx, feed, [story], 0);
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:favorite:([a-f0-9]{16})$/, async (ctx) => {
    try {
      const feed = await getNewsFeed();
      const story = feed.stories.find((item) => item.id === ctx.match[1]);
      if (!story) {
        await ctx.answerCallbackQuery({ text: "خبر دیگر در فهرست نیست." });
        await renderNewsHome(ctx);
        return;
      }
      const favorited = await toggleNewsFavorite(ctx.from.id, story.id);
      await ctx.answerCallbackQuery({ text: favorited ? "خبر ذخیره شد ⭐" : "از ذخیره‌ها حذف شد" });
      await showNewsCard(ctx, feed, [story], 0);
    } catch (error) {
      await ctx.answerCallbackQuery().catch(() => {});
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:alerts", async (ctx) => {
    try {
      const feed = await getNewsFeed();
      const selected = await getNewsSelection(ctx.from.id, feed.categories);
      const enabled = await getNewsAlertsEnabled(ctx.from.id);
      if (!enabled && !selected.length) {
        await ctx.answerCallbackQuery({ text: "اول یک یا چند دسته را انتخاب کن.", show_alert: true });
        await renderNewsSettings(ctx);
        return;
      }
      await setNewsAlertsEnabled(ctx.from.id, !enabled);
      await ctx.answerCallbackQuery({
        text: enabled ? "اعلان خودکار خاموش شد." : "اعلان برای دسته‌های انتخاب‌شده روشن شد.",
      });
      await renderNewsSettings(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery().catch(() => {});
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:view:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      const stories = feed.stories;
      const index = Number(ctx.match[1]);
      if (!stories.length || !Number.isSafeInteger(index) || index < 0 || index >= stories.length) {
        await renderNewsHome(ctx);
        return;
      }
      await showNewsCard(ctx, feed, stories, index);
    } catch (error) {
      await reportNewsError(ctx, error);
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