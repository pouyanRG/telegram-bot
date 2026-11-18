import { UserError } from "./errors";
import {
  beginNewsCategoryDraft,
  formatNewsItem,
  formatNewsTitle,
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
import { registerAdminPanel } from "./adminPanel";
import { registerMediaConvert } from "./mediaConvert";
import { SETTINGS, quotaExceededMessage } from "./config";
import { consumeQuota, refundQuota } from "./quota";
import { getCoinPrices, getPrices, formatPrices, formatTopMovers, findCoin, formatCoin } from "./prices";
import {
  clearPendingPriceAlert,
  createPriceAlert,
  deletePriceAlert,
  getPendingPriceAlert,
  getPriceAlerts,
  getWatchlist,
  removeWatchlistCoin,
  setPendingPriceAlert,
  toggleWatchlist,
  type CryptoCoin,
  type PriceAlert,
} from "./crypto";
import { dedupeUpdates, featureGuard, userGuard, throttle } from "./middleware";
import { isFeatureEnabled } from "./adminControls";
import { logOperationalError } from "./operationalErrors";
import { mainMenu, BTN } from "./menu";
import { handleVoice, voiceGuide } from "./voice";
import { clearMode, setVoiceMode } from "./mode";
import {
  addAdmin,
  isAdminUser,
  isOwner,
  takePendingSticker,
} from "./admins";

let _bot: Bot | null = null;

// ---------- متن‌ها ----------

const WELCOME =
  "👋 <b>سلام!</b>\nاز منوی زیر انتخاب کن از کدام بخش می‌خواهی استفاده کنی:";

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
  .text("⭐ واچ‌لیست", "prices:watchlist")
  .text("🔔 هشدارها", "prices:alerts")
  .row()
  .text("🚀 رشدها", "prices:top:gainers")
  .text("📉 افت‌ها", "prices:top:losers")
  .row()
  .text("🏠 منوی اصلی", "menu:home");

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
    kb.text(`${mark} ${label} (${category.count.toLocaleString("fa-IR-u-nu-latn")})`, `news:toggle:${category.id}`).row();
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
    `انتخاب‌شده: ${selectedCount.toLocaleString("fa-IR-u-nu-latn")} از ${total.toLocaleString("fa-IR-u-nu-latn")}`,
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
    .text("⬅️ فهرست خبرها", `news:list:${listKind}:${Math.floor(index / NEWS_PAGE_SIZE)}`)
    .text("⭐ ذخیره‌ها", "news:list:favorites:0")
    .row()
    .text("🏠 منو", "menu:home");
  return kb;
}

function coinKb(coin: CryptoCoin, isWatched: boolean) {
  return new InlineKeyboard()
    .text("🔄 بروزرسانی", `coin:${coin.id}`)
    .url("🌐 CoinGecko", `https://www.coingecko.com/en/coins/${coin.id}`)
    .row()
    .text(`${isWatched ? "⭐ حذف از واچ‌لیست" : "☆ افزودن به واچ‌لیست"}`, `crypto:watch:${coin.id}`)
    .text("🔔 هشدار قیمت", `crypto:alert:${coin.id}`)
    .row()
    .text("📊 بازار", "menu:prices")
    .text("🏠 منو", "menu:home");
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cryptoCoin(coin: { id: string; name: string; symbol: string }): CryptoCoin {
  return { id: coin.id, name: coin.name, symbol: coin.symbol };
}

function cryptoCoinText(coin: CryptoCoin) {
  return `${escapeHtml(coin.name)} (${escapeHtml(coin.symbol)})`;
}

function formatAlert(alert: PriceAlert) {
  const direction = alert.direction === "above" ? "بالاتر از" : "پایین‌تر از";
  return `${cryptoCoinText(alert.coin)} ${direction} $${alert.price.toLocaleString("en-US")}`;
}

function parsePriceInput(value: string) {
  const normalized = value
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[٬,\s]/g, "")
    .replace(/٫/g, ".");
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function watchlistKeyboard(coins: CryptoCoin[]) {
  const keyboard = new InlineKeyboard();
  for (const coin of coins) {
    keyboard.text(`${coin.symbol} · نمایش`, `coin:${coin.id}`)
      .text("حذف", `crypto:watchlist:remove:${coin.id}`)
      .row();
  }
  return keyboard.text("⬅️ بازار", "menu:prices").text("🏠 منو", "menu:home");
}

function alertsKeyboard(alerts: PriceAlert[]) {
  const keyboard = new InlineKeyboard();
  for (const alert of alerts) {
    keyboard.text(`✖ ${alert.coin.symbol} $${alert.price.toLocaleString("en-US")}`, `crypto:alert:delete:${alert.id}`).row();
  }
  return keyboard.text("⬅️ بازار", "menu:prices").text("🏠 منو", "menu:home");
}

function topMoversKeyboard(direction: "gainers" | "losers") {
  return new InlineKeyboard()
    .text(direction === "gainers" ? "📉 نمایش افت‌ها" : "🚀 نمایش رشدها", `prices:top:${direction === "gainers" ? "losers" : "gainers"}`)
    .row()
    .text("⬅️ بازار", "menu:prices")
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
    clearPendingPriceAlert(uid),
  ]).catch((e) => console.error("resetState error:", e));
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

async function renderWatchlist(ctx: Context) {
  const coins = await getWatchlist(ctx.from!.id);
  if (!coins.length) {
    await editOrReply(ctx, "⭐ واچ‌لیستت خالی است. از صفحهٔ هر رمزارز آن را اضافه کن.", watchlistKeyboard(coins));
    return;
  }
  try {
    const prices = await getCoinPrices(coins.map((coin) => coin.id));
    const rows = coins.map((coin) => {
      const price = prices[coin.id]?.usd;
      const value = price === undefined ? "داده در دسترس نیست" : `$${price.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
      return `▫️ <b>${cryptoCoinText(coin)}</b> · ${value}`;
    });
    await editOrReply(ctx, [`⭐ <b>واچ‌لیست من</b>`, "", ...rows].join("\n"), watchlistKeyboard(coins));
  } catch (error) {
    console.error("crypto watchlist error:", error);
    await editOrReply(ctx, "⚠️ الان نمی‌توانم قیمت‌های واچ‌لیست را بگیرم.", watchlistKeyboard(coins));
  }
}

async function renderPriceAlerts(ctx: Context) {
  const alerts = await getPriceAlerts(ctx.from!.id);
  const text = alerts.length
    ? [`🔔 <b>هشدارهای فعال</b>`, "", ...alerts.map((alert) => `▫️ ${formatAlert(alert)}`)].join("\n")
    : "🔔 هشدار فعالی نداری. برای ساخت هشدار، یک رمزارز را باز کن و «هشدار قیمت» را بزن.";
  await editOrReply(ctx, text, alertsKeyboard(alerts));
}

async function renderTopMovers(ctx: Context, direction: "gainers" | "losers") {
  try {
    const { data } = await getPrices();
    await editOrReply(ctx, formatTopMovers(data, direction), topMoversKeyboard(direction));
  } catch (error) {
    console.error("crypto top movers error:", error);
    await editOrReply(ctx, "⚠️ الان نمی‌توانم برترین‌های بازار را بگیرم.", topMoversKeyboard(direction));
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

const NEWS_PAGE_SIZE = 5;

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
        .text("⬅️ بازگشت", "menu:news")
    );
    return;
  }

  const pageCount = Math.ceil(stories.length / NEWS_PAGE_SIZE);
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * NEWS_PAGE_SIZE;
  const visibleStories = stories.slice(start, start + NEWS_PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  const headlines = visibleStories.map((story, index) => {
    const number = (start + index + 1).toLocaleString("fa-IR-u-nu-latn");
    return `<blockquote>\u200f${number}. ${formatNewsTitle(story.title, 110)}</blockquote>`;
  });
  visibleStories.forEach((story, index) => {
    const number = (start + index + 1).toLocaleString("fa-IR-u-nu-latn");
    keyboard
      .text(`📰 خبر ${number}`, `news:open:${kind}:${story.id}`);
    if (index % 2 === 1 || index === visibleStories.length - 1) keyboard.row();
  });
  if (currentPage > 0) keyboard.text("⬅️ قبلی", `news:page:${kind}:${currentPage - 1}`);
  if (currentPage + 1 < pageCount) {
    keyboard.text("بعدی ➡️", `news:page:${kind}:${currentPage + 1}`);
  }
  if (currentPage > 0 || currentPage + 1 < pageCount) keyboard.row();
  keyboard
    .text("⬅️ بازگشت", "menu:news")
    .text("⚙️ تنظیمات خبرها", "news:settings");

  const position = `صفحهٔ ${(currentPage + 1).toLocaleString("fa-IR-u-nu-latn")} از ${pageCount.toLocaleString("fa-IR-u-nu-latn")} · ${stories.length.toLocaleString("fa-IR-u-nu-latn")} خبر`;
  const staleNotice = feed.stale ? "\n\n⚠️ فید تازه نشد؛ خبرهای ذخیره‌شده را می‌بینی." : "";
  const listText = [
    newsListTitle(kind),
    position,
    "",
    headlines.join("\n\n"),
    "برای خواندن متن کامل، شمارهٔ همان خبر را بزن.",
    staleNotice,
  ].filter(Boolean).join("\n\n");
  await editOrReply(ctx, listText, keyboard);
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
  listKind: NewsListKind,
  sendAsNewMessage = false
) {
  const story = stories[index];
  if (!story) return;
  const staleNotice = feed.stale
    ? "\n\n⚠️ فید موقتاً به‌روز نشد؛ این خبر از نسخهٔ ذخیره‌شده است."
    : "";
  const captionLimit = story.imageUrl ? 1024 - (staleNotice ? 100 : 0) : 4096;
  const body = formatNewsItem(story, index, stories.length, captionLimit);
  const caption = `${body}${staleNotice}`;
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

  if (sendAsNewMessage || !message) {
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

/** /menu و دکمه‌ی پایین «منو»: نمایش کیبورد اصلی */
async function showHome(ctx: Context) {
  await resetState(ctx);
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
  bot.use(featureGuard);
  bot.use(throttle);

  // ================= دستورهای عمومی =================

  bot.command("start", async (ctx) => {
    await resetState(ctx);
    await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
  });

  bot.command("menu", showHome);

  bot.command("help", async (ctx) => {
    await resetState(ctx);
    const id = ctx.from?.id;
    let text = HELP_USER;
    if (id && (await isAdminUser(id))) text += "\n" + HELP_ADMIN;
    if (id && isOwner(id)) text += "\n" + HELP_OWNER;
    await ctx.reply(text, { ...HTML, reply_markup: await menuFor(ctx) });
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
    const id = ctx.from?.id;
    let text = HELP_USER;
    if (id && (await isAdminUser(id))) text += "\n" + HELP_ADMIN;
    if (id && isOwner(id)) text += "\n" + HELP_OWNER;
    await ctx.reply(text, { ...HTML, reply_markup: await menuFor(ctx) });
  });

  bot.hears(BTN.prices, async (ctx) => {
    await resetState(ctx);
    await sendPrices(ctx);
  });

  bot.hears(BTN.news, async (ctx) => {
    await resetState(ctx);
    await ctx.reply(newsHomeText(), { ...HTML, reply_markup: newsHomeKb() });
  });

  bot.hears(BTN.voice, async (ctx) => {
    const id = ctx.from?.id;
    if (!id) return;
    await takePendingSticker(id).catch(() => {});
    await setVoiceMode(id);
    await voiceGuide(ctx);
  });

  registerAdminPanel(bot);
  registerMediaConvert(bot);

  // ================= ناوبری منو (ویرایش همان پیام) =================

  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetState(ctx);
    await ctx.reply(WELCOME, { ...HTML, reply_markup: await menuFor(ctx) });
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetState(ctx);
    let text = HELP_USER;
    if (await isAdminUser(ctx.from.id)) text += "\n" + HELP_ADMIN;
    if (isOwner(ctx.from.id)) text += "\n" + HELP_OWNER;
    await ctx.reply(text, { ...HTML, reply_markup: await menuFor(ctx) });
  });

  // ================= قیمت‌ها =================

  bot.callbackQuery("menu:prices", async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetState(ctx);
    await sendPrices(ctx);
  });

  bot.callbackQuery("prices:watchlist", async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderWatchlist(ctx);
  });

  bot.callbackQuery("prices:alerts", async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderPriceAlerts(ctx);
  });

  bot.callbackQuery(/^prices:top:(gainers|losers)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderTopMovers(ctx, ctx.match[1] as "gainers" | "losers");
  });

  bot.callbackQuery(/^crypto:watch:(.+)$/, async (ctx) => {
    try {
      const coin = await findCoin(ctx.match[1], { byId: true });
      if (!coin) return void (await ctx.answerCallbackQuery({ text: "ارز پیدا نشد" }));
      const isWatched = await toggleWatchlist(ctx.from.id, cryptoCoin(coin));
      if (isWatched === null) return void (await ctx.answerCallbackQuery({ text: "واچ‌لیست حداکثر ۲۰ ارز دارد" }));
      await ctx.editMessageText(formatCoin(coin), {
        ...HTML,
        ...NO_PREVIEW,
        reply_markup: coinKb(cryptoCoin(coin), isWatched),
      });
      await ctx.answerCallbackQuery({ text: isWatched ? "به واچ‌لیست اضافه شد ⭐" : "از واچ‌لیست حذف شد" });
    } catch (error) {
      if (!isNotModified(error)) console.error("crypto watchlist toggle error:", error);
      await ctx.answerCallbackQuery({ text: "⚠️ ذخیره‌سازی انجام نشد" });
    }
  });

  bot.callbackQuery(/^crypto:watchlist:remove:(.+)$/, async (ctx) => {
    await removeWatchlistCoin(ctx.from.id, ctx.match[1]);
    await renderWatchlist(ctx);
    await ctx.answerCallbackQuery({ text: "از واچ‌لیست حذف شد" });
  });

  bot.callbackQuery(/^crypto:alert:([^:]+)$/, async (ctx) => {
    try {
      const coin = await findCoin(ctx.match[1], { byId: true });
      if (!coin) return void (await ctx.answerCallbackQuery({ text: "ارز پیدا نشد" }));
      const keyboard = new InlineKeyboard()
        .text("وقتی بالاتر رفت", `crypto:alertdir:above:${coin.id}`)
        .row()
        .text("وقتی پایین‌تر رفت", `crypto:alertdir:below:${coin.id}`)
        .row()
        .text("لغو", `coin:${coin.id}`);
      await editOrReply(ctx, `🔔 <b>هشدار ${cryptoCoinText(cryptoCoin(coin))}</b>\n\nنوع هشدار را انتخاب کن:`, keyboard);
      await ctx.answerCallbackQuery();
    } catch (error) {
      console.error("crypto alert setup error:", error);
      await ctx.answerCallbackQuery({ text: "⚠️ الان نمی‌توانم هشدار بسازم" });
    }
  });

  bot.callbackQuery(/^crypto:alertdir:(above|below):(.+)$/, async (ctx) => {
    try {
      const coin = await findCoin(ctx.match[2], { byId: true });
      if (!coin) return void (await ctx.answerCallbackQuery({ text: "ارز پیدا نشد" }));
      const direction = ctx.match[1] as "above" | "below";
      await setPendingPriceAlert(ctx.from.id, { coin: cryptoCoin(coin), direction });
      const relation = direction === "above" ? "بالاتر" : "پایین‌تر";
      await ctx.reply(`قیمت هدف ${cryptoCoinText(cryptoCoin(coin))} را به دلار بفرست؛ هشدار وقتی فعال می‌شود که قیمت ${relation} آن برود.\nنمونه: <code>65000</code>`, HTML);
      await ctx.answerCallbackQuery();
    } catch (error) {
      console.error("crypto alert direction error:", error);
      await ctx.answerCallbackQuery({ text: "⚠️ ذخیره‌سازی انجام نشد" });
    }
  });

  bot.callbackQuery(/^crypto:alert:delete:([a-z0-9]+)$/, async (ctx) => {
    await deletePriceAlert(ctx.from.id, ctx.match[1]);
    await renderPriceAlerts(ctx);
    await ctx.answerCallbackQuery({ text: "هشدار حذف شد" });
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
      await showNewsCard(ctx, feed, stories, index, listKind, true);
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
      const watchlist = await getWatchlist(ctx.from.id);
      await ctx.editMessageText(formatCoin(coin), {
        ...HTML,
        ...NO_PREVIEW,
        reply_markup: coinKb(cryptoCoin(coin), watchlist.some((item) => item.id === coin.id)),
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
    const userId = ctx.from.id;
    const pendingAlert = await getPendingPriceAlert(userId);
    if (pendingAlert) {
      const price = parsePriceInput(ctx.message.text.trim());
      if (price === null) {
        return void (await ctx.reply("قیمت معتبر نیست. فقط یک عدد مثبت به دلار بفرست؛ نمونه: <code>65000</code>.", HTML));
      }
      const alert = await createPriceAlert(userId, { ...pendingAlert, price });
      await clearPendingPriceAlert(userId);
      if (!alert) {
        return void (await ctx.reply("حداکثر ۱۰ هشدار فعال می‌توانی داشته باشی. برای ادامه یکی را از بخش هشدارها حذف کن.", {
          ...HTML,
          reply_markup: new InlineKeyboard().text("🔔 مدیریت هشدارها", "prices:alerts"),
        }));
      }
      return void (await ctx.reply(`✅ هشدار ثبت شد: ${formatAlert(alert)}`, {
        ...HTML,
        reply_markup: new InlineKeyboard().text("🔔 مدیریت هشدارها", "prices:alerts"),
      }));
    }

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
    if (!(await isFeatureEnabled("coin")) && !(await isAdminUser(uid))) {
      return void (await ctx.reply("⏸ قابلیت جستجوی ارز موقتاً غیرفعال است."));
    }
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
        reply_markup: coinKb(cryptoCoin(coin), (await getWatchlist(uid)).some((item) => item.id === coin.id)),
      });
    } catch (e) {
      console.error("coin lookup error:", e);
      await refund();
      await ctx.reply("⚠️ الان نمی‌توانم این ارز را بگیرم. کمی بعد دوباره امتحان کن.");
    }
  });

  bot.catch(async (err) => {
    console.error("Bot error:", err);
    await logOperationalError("telegram.bot", err.error);
  });

  _bot = bot;
  return bot;
}
