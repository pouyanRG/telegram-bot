import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { eq, like } from "drizzle-orm";
import { UserError } from "../errors";
import { getDb } from "../db";
import { cache } from "../schema";

const FEED_URL = "https://www.iranintl.com/feed";
const FEED_CACHE_KEY = "news:rss:iranintl:v1";
const PREFERENCES_KEY = (userId: number) => `news-pref:iranintl:${userId}`;
const USER_STATE_KEY = (userId: number) => `news-state:iranintl:${userId}`;
const ALERT_CURSOR_KEY = "news:alerts:cursor:v1";
const FEED_TTL_MS = 12 * 60_000;
const MAX_STORIES = 100;
const DEFAULT_CATEGORY = "بدون دسته‌بندی";

export type NewsStory = {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string | null;
  categoryId: string;
  category: string;
};

export type NewsCategory = { id: string; label: string; count: number };
export type NewsFeed = {
  stories: NewsStory[];
  categories: NewsCategory[];
  updatedAt: string;
  stale: boolean;
};

type CachedFeed = Pick<NewsFeed, "stories" | "categories">;
export type NewsUserState = {
  favoriteIds: string[];
  readIds: string[];
  deliveredIds: string[];
};
type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as XmlRecord;
  return text(record["#text"] ?? record.__cdata ?? "");
}

function attribute(value: unknown, name: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return text((value as XmlRecord)[`@_${name}`]);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeHtmlEntities(value: string) {
  return value.replace(
    /&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|rsquo|lsquo|rdquo|ldquo);/gi,
    (entity, code: string) => {
      if (code[0] === "#") {
        const hex = code[1]?.toLowerCase() === "x";
        const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity;
      }
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
        ndash: "–",
        mdash: "—",
        hellip: "…",
        rsquo: "’",
        lsquo: "‘",
        rdquo: "”",
        ldquo: "“",
      };
      return named[code.toLowerCase()] ?? entity;
    }
  );
}

function plainText(value: unknown, maxLength: number) {
  const clean = decodeHtmlEntities(text(value))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, maxLength).join("");
}

function safeUrl(value: string) {
  try {
    const url = new URL(value, FEED_URL);
    return url.protocol === "https:" && url.href.length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}

function categoryFor(value: unknown) {
  for (const candidate of asArray(value)) {
    const label = plainText(candidate, 80) || DEFAULT_CATEGORY;
    const id = createHash("sha256")
      .update(label.toLocaleLowerCase("fa"))
      .digest("hex")
      .slice(0, 12);
    return { id, label };
  }
  const id = createHash("sha256").update(DEFAULT_CATEGORY).digest("hex").slice(0, 12);
  return { id, label: DEFAULT_CATEGORY };
}

function enclosureUrl(value: unknown) {
  for (const enclosure of asArray(value)) {
    const url = safeUrl(attribute(enclosure, "url"));
    const type = attribute(enclosure, "type");
    if (url && (!type || type.toLowerCase().startsWith("image/"))) return url;
  }
  return null;
}

export function parseRssFeed(xml: string): CachedFeed {
  const parsed = parser.parse(xml) as XmlRecord;
  const channel = (parsed.rss as XmlRecord | undefined)?.channel as XmlRecord | undefined;
  if (!channel || typeof channel !== "object") throw new Error("RSS channel is missing");

  const seen = new Set<string>();
  const stories: NewsStory[] = [];
  for (const raw of asArray(channel.item)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as XmlRecord;
    const title = plainText(item.title, 220);
    const url = safeUrl(text(item.link));
    if (!title || !url) continue;

    const guid = text(item.guid);
    if (seen.has(url) || (guid && seen.has(guid))) continue;
    seen.add(url);
    if (guid) seen.add(guid);
    const identity = guid || url;

    const category = categoryFor(item.category);
    const date = Date.parse(text(item.pubDate));
    stories.push({
      id: createHash("sha256").update(identity).digest("hex").slice(0, 16),
      title,
      description: plainText(item.description, 700),
      url,
      imageUrl: enclosureUrl(item.enclosure),
      publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
      categoryId: category.id,
      category: category.label,
    });
  }

  stories.sort((a, b) => {
    const left = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const right = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return right - left;
  });
  const limitedStories = stories.slice(0, MAX_STORIES);
  const categoryCounts = new Map<string, NewsCategory>();
  for (const story of limitedStories) {
    const category = categoryCounts.get(story.categoryId);
    if (category) category.count += 1;
    else categoryCounts.set(story.categoryId, {
      id: story.categoryId,
      label: story.category,
      count: 1,
    });
  }

  return {
    stories: limitedStories,
    categories: [...categoryCounts.values()].sort((a, b) => a.label.localeCompare(b.label, "fa")),
  };
}

function isCachedFeed(value: unknown): value is CachedFeed {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CachedFeed>;
  return Array.isArray(data.stories) && Array.isArray(data.categories);
}

async function loadNewsFeed(forceRefresh = false): Promise<NewsFeed> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, FEED_CACHE_KEY));
  const cached = isCachedFeed(row?.data) ? row.data : null;
  if (!forceRefresh && cached && Date.now() - row.updatedAt.getTime() < FEED_TTL_MS) {
    return { ...cached, updatedAt: row.updatedAt.toISOString(), stale: false };
  }

  let fresh: CachedFeed;
  try {
    const response = await fetch(FEED_URL, {
      headers: {
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        "user-agent": "TelegramBot RSS reader",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`RSS request failed with HTTP ${response.status}`);
    fresh = parseRssFeed(await response.text());
  } catch (error) {
    console.error("Iran International RSS refresh failed:", error instanceof Error ? error.message : "unknown");
    if (cached && row) {
      return { ...cached, updatedAt: row.updatedAt.toISOString(), stale: true };
    }
    throw new UserError("فعلاً نمی‌توانم خبرها را دریافت کنم. کمی بعد دوباره امتحان کن.");
  }

  const now = new Date();
  await getDb()
    .insert(cache)
    .values({ key: FEED_CACHE_KEY, data: fresh, updatedAt: now })
    .onConflictDoUpdate({ target: cache.key, set: { data: fresh, updatedAt: now } });
  return { ...fresh, updatedAt: now.toISOString(), stale: false };
}

const inFlight = new Map<string, Promise<NewsFeed>>();

export function getNewsFeed() {
  const running = inFlight.get(FEED_CACHE_KEY);
  if (running) return running;
  const request = loadNewsFeed().finally(() => inFlight.delete(FEED_CACHE_KEY));
  inFlight.set(FEED_CACHE_KEY, request);
  return request;
}

export async function refreshNewsFeed() {
  return loadNewsFeed(true);
}

export async function getNewsAlertCursor(): Promise<string[] | null> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, ALERT_CURSOR_KEY));
  const ids = (row?.data as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
}

export async function setNewsAlertCursor(ids: string[]) {
  const data = { ids: [...new Set(ids)].slice(0, MAX_STORIES) };
  await getDb()
    .insert(cache)
    .values({ key: ALERT_CURSOR_KEY, data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

function validIds(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && /^[a-f0-9]{16}$/.test(id)))]
    .slice(-limit);
}

export async function getNewsUserState(userId: number): Promise<NewsUserState> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, USER_STATE_KEY(userId)));
  const data = row?.data as Partial<NewsUserState> | undefined;
  return {
    favoriteIds: validIds(data?.favoriteIds, 100),
    readIds: validIds(data?.readIds, 300),
    deliveredIds: validIds(data?.deliveredIds, 500),
  };
}

async function updateNewsUserState(userId: number, update: (state: NewsUserState) => NewsUserState) {
  const data = update(await getNewsUserState(userId));
  await getDb()
    .insert(cache)
    .values({ key: USER_STATE_KEY(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
  return data;
}

export async function markNewsRead(userId: number, storyId: string) {
  await updateNewsUserState(userId, (state) => ({
    ...state,
    readIds: validIds([...state.readIds, storyId], 300),
  }));
}

export async function toggleNewsFavorite(userId: number, storyId: string) {
  let favorited = false;
  await updateNewsUserState(userId, (state) => {
    const favorites = new Set(state.favoriteIds);
    if (favorites.has(storyId)) favorites.delete(storyId);
    else favorites.add(storyId);
    favorited = favorites.has(storyId);
    return { ...state, favoriteIds: validIds([...favorites], 100) };
  });
  return favorited;
}

export async function markNewsDelivered(userId: number, storyId: string) {
  await updateNewsUserState(userId, (state) => ({
    ...state,
    deliveredIds: validIds([...state.deliveredIds, storyId], 500),
  }));
}

export async function getNewsAlertSubscribers() {
  const rows = await getDb().select().from(cache).where(like(cache.key, "news-pref:iranintl:%"));
  return rows.flatMap((row) => {
    const match = /^news-pref:iranintl:(\d+)$/.exec(row.key);
    const data = row.data as { selected?: unknown; alertsEnabled?: unknown };
    const userId = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(userId) || userId <= 0 || data.alertsEnabled !== true) return [];
    const selected = validCategoryIds(data.selected);
    return selected.length ? [{ userId, selected }] : [];
  });
}

function validCategoryIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && /^[a-f0-9]{12}$/.test(id)))];
}

async function getPreferences(userId: number) {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, PREFERENCES_KEY(userId)));
  return (row?.data as { selected?: unknown; draftSelected?: unknown; alertsEnabled?: unknown } | undefined) ?? {};
}

export async function getNewsSelection(userId: number, categories: NewsCategory[]) {
  const available = new Set(categories.map((category) => category.id));
  const data = await getPreferences(userId);
  if (!Array.isArray(data?.selected)) return [];
  return data.selected.filter((id): id is string => typeof id === "string" && available.has(id));
}

export async function setNewsSelection(userId: number, selected: string[], categories: NewsCategory[]) {
  const allowed = new Set(categories.map((category) => category.id));
  const previous = await getPreferences(userId);
  const nextSelection = [...new Set(selected.filter((id) => allowed.has(id)))];
  const data = {
    selected: nextSelection,
    alertsEnabled: nextSelection.length > 0 && previous.alertsEnabled === true,
  };
  await getDb()
    .insert(cache)
    .values({ key: PREFERENCES_KEY(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function beginNewsCategoryDraft(userId: number, categories: NewsCategory[]) {
  const selected = await getNewsSelection(userId, categories);
  const previous = await getPreferences(userId);
  const data = {
    selected: validCategoryIds(previous.selected).filter((id) => categories.some((category) => category.id === id)),
    draftSelected: selected,
    alertsEnabled: previous.alertsEnabled === true,
  };
  await getDb()
    .insert(cache)
    .values({ key: PREFERENCES_KEY(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function getNewsCategoryDraft(userId: number, categories: NewsCategory[]) {
  const available = new Set(categories.map((category) => category.id));
  const preferences = await getPreferences(userId);
  const draft = Array.isArray(preferences.draftSelected) ? preferences.draftSelected : preferences.selected;
  if (!Array.isArray(draft)) return [];
  return draft.filter((id): id is string => typeof id === "string" && available.has(id));
}

export async function getNewsAlertsEnabled(userId: number) {
  return (await getPreferences(userId)).alertsEnabled === true;
}

export async function setNewsAlertsEnabled(userId: number, enabled: boolean) {
  const previous = await getPreferences(userId);
  const selected = validCategoryIds(previous.selected);
  const data = { selected, alertsEnabled: enabled };
  await getDb()
    .insert(cache)
    .values({ key: PREFERENCES_KEY(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function toggleNewsCategoryDraft(
  userId: number,
  categoryId: string,
  categories: NewsCategory[]
) {
  if (!categories.some((category) => category.id === categoryId)) {
    throw new UserError("این دسته‌بندی دیگر در فید موجود نیست؛ فهرست را دوباره باز کن.");
  }
  const selected = await getNewsCategoryDraft(userId, categories);
  const next = new Set(selected);
  if (next.has(categoryId)) next.delete(categoryId);
  else next.add(categoryId);
  const previous = await getPreferences(userId);
  const data = {
    selected: validCategoryIds(previous.selected),
    draftSelected: [...next],
    alertsEnabled: previous.alertsEnabled === true,
  };
  await getDb()
    .insert(cache)
    .values({ key: PREFERENCES_KEY(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
  return [...next];
}

export function formatNewsItem(story: NewsStory, index: number, total: number) {
  const published = story.publishedAt
    ? new Date(story.publishedAt).toLocaleString("fa-IR", {
        timeZone: "Asia/Tehran",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "زمان نامشخص";
  const title = escapeHtml(Array.from(story.title).slice(0, 180).join(""));
  const description = escapeHtml(Array.from(story.description).slice(0, 550).join(""));
  return [
    `📰 <b>${title}</b>`,
    description ? `\n${description}` : "",
    "",
    `🕒 ${published}`,
    `🏷 ${escapeHtml(Array.from(story.category).slice(0, 80).join(""))}`,
    `\n${index + 1} از ${total}`,
  ].filter(Boolean).join("\n");
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
