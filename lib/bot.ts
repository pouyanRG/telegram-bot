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
  refreshNewsFeed,
  setNewsAlertsEnabled,
  setNewsSelection,
  toggleNewsFavorite,
  toggleNewsCategoryDraft,
  type NewsCategory,
  type NewsFeed,
  type NewsStory,
} from "./news";
import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import { registerReports, clearReport } from "./reports";
import { SETTINGS, quotaExceededMessage } from "./config";
import { consumeQuota, refundQuota } from "./quota";
import { getPrices, formatPrices, findCoin, formatCoin } from "./prices";
import { dedupeUpdates, userGuard, throttle } from "./middleware";
import { mainMenu, BTN, idleKb } from "./menu";
import { handleVoice, voiceGuide } from "./voice";
import { clearMode, setVoiceMode } from "./mode";
import { getCoins } from "./coins";
import { COINS_INFO } from "./texts";
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

let _bot: Bot | null = null;

// ---------- متن‌ها ----------

const WELCOME =
  "👋 <b>سلام!</b>\nاز منوی زیر انتخاب کن از کدام بخش می‌خواهی استفاده کنی:";

const SETTINGS_TEXT = "⚙️ <b>تنظیمات</b>\nیکی از گزینه‌ها را انتخاب کن:";

const HELP_USER = [
  "ℹ️ <b>راهنما</b>",
  "",
  "▫️ /menu — منوی اصلی",
  "▫️ /prices — وضعیت بازار ارزهای دیجیتال",
  "▫️ نام یا نماد هر ارز (مثل <code>btc</code> یا <code>solana</code> یا <code>بیت‌کوین</code>) را بفرست تا رمزارز را ببینی",
  "▫️ برای تبدیل ویس به متن، از منو «🎙 ویس به متن» را بزن و بعد ویس بفرست",
  "▫️ از منوی اصلی «📰 اخبار روز» را بزن، دسته‌های دلخواهت را انتخاب کن و خبرها را بخوان",
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

type NewsListKind = "all" | "unread" | "favorites" | "history";

const pricesKb = new InlineKeyboard()
  .text("🔄 بروزرسانی", "prices:refresh")
  .row()
  .text("🏠 منوی اصلی", "menu:home");
const cancelStickerKb = new InlineKeyboard().text("❌ انصراف", "admin:sticker_cancel");

function newsHomeKb() {
  const kb = new InlineKeyboard();
  return kb
    .text("📰 همه خبرها", "news:list:all:0")
    .text("🆕 خبرهای جدید", "news:list:unread:0")
    .row()
    .text("⭐ ذخیره‌ها", "news:list:favorites:0")
    .text("📚 خوانده‌شده‌ها", "news:list:history:0")
    .row()
    .text("🔄 تازه‌سازی و نمایش", "news:refresh")
    .row()
    .text("⚙️ تنظیمات خبرها", "news:settings");
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
  return [
    "📰 <b>اخبار روز</b>",
    "",
    "خبرها را بر اساس وضعیت دلخواهت ببین؛ برای مطالعهٔ خبر روی عنوانش بزن.",
    "خبرهای جدید بر اساس دسته‌هایی هستند که در تنظیمات انتخاب کرده‌ای.",
  ].join("\n");
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

function newsCardKeyboard(
  index: number,
  stories: NewsStory[],
  storyId: string,
  isFavorite: boolean,
  listKind: NewsListKind
) {
  const kb = new InlineKeyboard();
  if (index > 0) kb.text("⬅️ خبر قبلی", `news:open:${listKind}:${stories[index - 1].id}`);
  if (index + 1 < stories.length) {
    kb.text("خبر بعدی ➡️", `news:open:${listKind}:${stories[index + 1].id}`);
  }
  if (index > 0 || index + 1 < stories.length) kb.row();
  kb.text(isFavorite ? "⭐ ذخیره‌شده" : "☆ ذخیره خبر", `news:favorite:${storyId}`)
    .row()
    .url("🔗 متن کامل خبر", stories[index].url)
    .row()
    .text("⭐ ذخیره‌ها", "news:list:favorites:0")
    .text("⬅️ فهرست خبرها", `news:list:${listKind}:${Math.floor(index / NEWS_PAGE_SIZE)}`)
    .row()
    .text("🏠 منو", "menu:home");
  return kb;
}

const backToSettingsKb = new InlineKeyboard().text("🔙 برگشت", "menu:settings");

/** دکمه‌های تنظیمات؛ فقط بعد از زدن «Setting» دیده می‌شوند و با «برگشت» از بین می‌روند */
function settingsKb(owner: boolean) {
  const kb = new InlineKeyboard().text("🎞 تنظیم استیکر فکرکردن", "admin:sticker").row();
  kb.text("🚨 گزارش‌ها", "admin:reports").row();
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

/** هر بار که کاربر در منو جابه‌جا می‌شود، حالت‌های موقت پاک می‌شوند */
async function resetState(ctx: Context) {
  const uid = ctx.from?.id;
  if (!uid) return;
  await Promise.all([
    clearMode(uid),
    takePendingSticker(uid),
    clearReport(uid),
  ]).catch((e) => console.error("resetState error:", e));
}

async function clearLegacyReplyKeyboard(ctx: Context) {
  await ctx.reply("✅ منو به‌روز شد.", { reply_markup: { remove_keyboard: true } });
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
  const available = new Set(feed.categories.map((c) => c.id));
  await renderNewsScreen(
    ctx,
    newsCategoriesText(selected.filter((id) => available.has(id)).length, feed.categories.length),
    newsCategoriesKb(feed.categories, selected)
  );
}

async function getNewsListStories(userId: number, feed: NewsFeed, kind: NewsListKind) {
  if (kind === "all") return feed.stories;
  const state = await getNewsUserState(userId);
  if (kind === "favorites") {
    return feed.stories.filter((story) => state.favoriteIds.includes(story.id));
  }
  if (kind === "history") {
    return feed.stories.filter((story) => state.readIds.includes(story.id));
  }
  const selected = new Set(await getNewsSelection(userId, feed.categories));
  return feed.stories.filter(
    (story) => selected.has(story.categoryId) && !state.readIds.includes(story.id)
  );
}

const NEWS_PAGE_SIZE = 8;

function newsListTitle(kind: NewsListKind) {
  switch (kind) {
    case "all": return "📰 <b>همهٔ خبرها</b>";
    case "unread": return "🆕 <b>خبرهای جدید و خوانده‌نشده</b>";
    case "favorites": return "⭐ <b>خبرهای ذخیره‌شده</b>";
    case "history": return "📚 <b>خبرهای خوانده‌شده</b>";
  }
}

async function showNewsList(ctx: Context, feed: NewsFeed, kind: NewsListKind, page = 0) {
  const stories = await getNewsListStories(ctx.from!.id, feed, kind);
  if (
    kind === "unread" &&
    !stories.length &&
    !(await getNewsSelection(ctx.from!.id, feed.categories)).length
  ) {
    await renderNewsCategories(ctx, feed);
    return;
  }
  if (!stories.length) {
    await editOrReply(
      ctx,
      `${newsListTitle(kind)}\n\nفعلاً خبری در این فهرست نیست.`,
      new InlineKeyboard()
        .text(
          kind === "unread" ? "🏷 انتخاب دسته‌ها" : "⚙️ تنظیمات خبرها",
          kind === "unread" ? "news:categories" : "news:settings"
        )
        .row()
        .text("⬅️ اخبار روز", "menu:news")
    );
    return;
  }

  const pageCount = Math.ceil(stories.length / NEWS_PAGE_SIZE);
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * NEWS_PAGE_SIZE;
  const visibleStories = stories.slice(start, start + NEWS_PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  visibleStories.forEach((story) => {
    const characters = Array.from(story.title);
    const title = characters.slice(0, 48).join("");
    keyboard
      .text(`📰 ${title}${characters.length > 48 ? "…" : ""}`, `news:open:${kind}:${story.id}`)
      .row();
  });
  if (currentPage > 0) keyboard.text("⬅️ قبلی", `news:page:${kind}:${currentPage - 1}`);
  if (currentPage + 1 < pageCount) {
    keyboard.text("بعدی ➡️", `news:page:${kind}:${currentPage + 1}`);
  }
  if (currentPage > 0 || currentPage + 1 < pageCount) keyboard.row();
  keyboard
    .text("⚙️ تنظیمات خبرها", "news:settings")
    .text("⬅️ اخبار روز", "menu:news");

  const position = `صفحهٔ ${(currentPage + 1).toLocaleString("fa-IR")} از ${pageCount.toLocaleString("fa-IR")} · ${stories.length.toLocaleString("fa-IR")} خبر`;
  const staleNotice = feed.stale ? "\n\n⚠️ فید تازه نشد؛ خبرهای ذخیره‌شده را می‌بینی." : "";
  await editOrReply(ctx, `${newsListTitle(kind)}\n${position}${staleNotice}`, keyboard);
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
  index: number,
  listKind: NewsListKind
) {
  const story = stories[index];
  if (!story) return;
  const body = formatNewsItem(story, index, stories.length);
  const caption = feed.stale
    ? `${body}\n\n⚠️ فید موقتاً به‌روز نشد؛ این خبر از نسخهٔ ذخیره‌شده است.`
    : body;
  const userId = ctx.from!.id;
  const state = await getNewsUserState(userId);
  const keyboard = newsCardKeyboard(
    index,
    stories,
    story.id,
    state.favoriteIds.includes(story.id),
    listKind
  );
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

// ---------- شروع و منوی اصلی ----------

/** /menu و دکمه‌ی «📋 منو»: منوی اینلاین اصلی */
async function showHome(ctx: Context) {
  await resetState(ctx);
  await clearLegacyReplyKeyboard(ctx);
  await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
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

  // ================= دستورهای عمومی =================

  bot.command("start", async (ctx) => {
    await resetState(ctx);
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

  // ================= کیبورد ثابت پایین =================

  bot.hears(BTN.menu, showHome);
  bot.hears(BTN.help, async (ctx) => {
    await resetState(ctx);
    await clearLegacyReplyKeyboard(ctx);
    await ctx.reply(HELP_USER, { ...HTML, reply_markup: homeKb });
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

  // دکمه‌ی کیبورد پایین که هنوز بخشی پشتش نیست
  bot.hears(BTN.feedback, async (ctx) => {
    await resetState(ctx);
    await ctx.reply("این بخش به‌زودی فعال می‌شود 🚧");
  });

  registerReports(bot);

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

  bot.callbackQuery(/^news:list:(all|unread|favorites|history):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      await showNewsList(ctx, feed, ctx.match[1] as NewsListKind, Number(ctx.match[2]));
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:page:(all|unread|favorites|history):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      await showNewsList(ctx, feed, ctx.match[1] as NewsListKind, Number(ctx.match[2]));
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:refresh", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "خبرها در حال تازه‌سازی هستند…" });
    try {
      const feed = await refreshNewsFeed();
      await showNewsList(ctx, feed, "all");
    } catch (error) {
      await reportNewsError(ctx, error);
    }
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
      await showNewsList(ctx, feed, "all");
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
      await showNewsList(ctx, feed, "unread");
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:favorites", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      await showNewsList(ctx, feed, "favorites");
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery("news:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      await showNewsList(ctx, feed, "history");
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:open:(all|unread|favorites|history):([a-f0-9]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      const listKind = ctx.match[1] as NewsListKind;
      const stories = await getNewsListStories(ctx.from.id, feed, listKind);
      const index = stories.findIndex((story) => story.id === ctx.match[2]);
      if (index < 0) {
        await showNewsList(ctx, feed, listKind);
        return;
      }
      await showNewsCard(ctx, feed, stories, index, listKind);
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  bot.callbackQuery(/^news:open:([a-f0-9]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const feed = await getNewsFeed();
      const index = feed.stories.findIndex((item) => item.id === ctx.match[1]);
      if (index < 0) {
        await renderNewsHome(ctx);
        return;
      }
      await showNewsCard(ctx, feed, feed.stories, index, "all");
    } catch (error) {
      await reportNewsError(ctx, error);
    }
  });

  // ذخیره/حذف از ذخیره‌ها: فقط برچسب دکمه عوض می‌شود و بقیه‌ی کیبورد (قبلی/بعدی و ...) دست‌نخورده می‌ماند
  bot.callbackQuery(/^news:favorite:([a-f0-9]{16})$/, async (ctx) => {
    try {
      const storyId = ctx.match[1];
      const favorited = await toggleNewsFavorite(ctx.from.id, storyId);
      await ctx.answerCallbackQuery({ text: favorited ? "خبر ذخیره شد ⭐" : "از ذخیره‌ها حذف شد" });

      const message = ctx.callbackQuery.message;
      const rows =
        message && "reply_markup" in message ? message.reply_markup?.inline_keyboard : undefined;
      if (!rows) return;
      const target = `news:favorite:${storyId}`;
      const inline_keyboard = rows.map((row) =>
        row.map((button) =>
          "callback_data" in button && button.callback_data === target
            ? { ...button, text: favorited ? "⭐ ذخیره‌شده" : "☆ ذخیره خبر" }
            : button
        )
      );
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard } }).catch((e) => {
        if (!isNotModified(e)) throw e;
      });
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
      await showNewsCard(ctx, feed, stories, index, "all");
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
