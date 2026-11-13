import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { eq } from "drizzle-orm";
import { UserError } from "../errors";
import { getDb } from "../db";
import { cache } from "../schema";

const FEED_URL = "https://www.iranintl.com/feed";
const FEED_CACHE_KEY = "news:rss:iranintl:v1";
const PREFERENCES_KEY = (userId: number) => `news-pref:iranintl:${userId}`;
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

async function loadNewsFeed(): Promise<NewsFeed> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, FEED_CACHE_KEY));
  const cached = isCachedFeed(row?.data) ? row.data : null;
  if (cached && Date.now() - row.updatedAt.getTime() < FEED_TTL_MS) {
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
    throw new UserError("فید خبر ایران‌اینترنشنال فعلاً در دسترس نیست. کمی بعد دوباره امتحان کن.");
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

export async function getNewsSelection(userId: number, categories: NewsCategory[]) {
  const [row] = await getDb()
    .select()
    .from(cache)
    .where(eq(cache.key, PREFERENCES_KEY(userId)));
  const available = new Set(categories.map((category) => category.id));
  const data = row?.data as { selected?: unknown } | undefined;
  if (!Array.isArray(data?.selected)) return [];
  return data.selected.filter((id): id is string => typeof id === "string" && available.has(id));
}

export async function setNewsSelection(userId: number, selected: string[], categories: NewsCategory[]) {
  const allowed = new Set(categories.map((category) => category.id));
  const data = { selected: [...new Set(selected.filter((id) => allowed.has(id)))] };
  await getDb()
    .insert(cache)
    .values({ key: PREFERENCES_KEY(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function toggleNewsCategory(
  userId: number,
  categoryId: string,
  categories: NewsCategory[]
) {
  if (!categories.some((category) => category.id === categoryId)) {
    throw new UserError("این دسته‌بندی دیگر در فید موجود نیست؛ فهرست را دوباره باز کن.");
  }
  const selected = await getNewsSelection(userId, categories);
  const next = new Set(selected);
  if (next.has(categoryId)) next.delete(categoryId);
  else next.add(categoryId);
  await setNewsSelection(userId, [...next], categories);
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
