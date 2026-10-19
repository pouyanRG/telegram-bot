import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { cache } from "../schema";
import { NEWS_CATEGORIES, WINDOWS, type WindowId } from "./categories";
import { searchNews, type GroundedLink, type NewsItem, type NewsStatus } from "./gemini";

// با عوض کردن پرامپت یا تنظیمات، این عدد را زیاد کن تا کش قدیمی بی‌اثر شود
const CONFIG_VERSION = 1;

type NewsResult = { items: NewsItem[]; links: GroundedLink[] };

const cacheKey = (cat: string, win: WindowId) => `news:v${CONFIG_VERSION}:${cat}:${win}`;

function filterByWindow(items: NewsItem[], win: WindowId): NewsItem[] {
  const now = Date.now();
  const minTs = now - WINDOWS[win].hours * 3600_000 - 10 * 60_000; // ۱۰ دقیقه تلورانس
  const seen = new Set<string>();
  const out: NewsItem[] = [];

  for (const it of items) {
    const t = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
    if (Number.isNaN(t)) {
      // زمان نامعلوم: برای بازه‌های کوتاه رد می‌شود
      if (win !== "24") continue;
    } else if (t < minTs || t > now + 5 * 60_000) {
      continue;
    }
    const k = it.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function load(
  cat: string,
  win: WindowId
): Promise<NewsResult & { updatedAt: Date; cached: boolean }> {
  const config = NEWS_CATEGORIES[cat];
  if (!config) throw new Error("unknown news category");

  const key = cacheKey(cat, win);
  const [row] = await getDb().select().from(cache).where(eq(cache.key, key));
  if (row && Date.now() - row.updatedAt.getTime() < config.ttlMin[win] * 60_000) {
    return { ...(row.data as NewsResult), updatedAt: row.updatedAt, cached: true };
  }

  const raw = await searchNews(config, win);
  const data: NewsResult = { items: filterByWindow(raw.items, win), links: raw.links };
  const now = new Date();
  await getDb()
    .insert(cache)
    .values({ key, data, updatedAt: now })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: now } });
  return { ...data, updatedAt: now, cached: false };
}

// درخواست‌های همزمان برای یک دسته و بازه در همین instance یکی می‌شوند
const _inflight = new Map<string, ReturnType<typeof load>>();

export function getNews(cat: string, win: WindowId) {
  const key = `${cat}:${win}`;
  const running = _inflight.get(key);
  if (running) return running;
  const p = load(cat, win).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ---------- قالب‌بندی (parse_mode: HTML) ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
const RLM = "\u200F";

const STATUS_FA: Record<NewsStatus, string> = {
  confirmed: "✅ تأییدشده از چند منبع مستقل",
  single: "☝️ گزارش یک منبع",
  official_claim: "🏛 ادعای رسمی، تأییدنشده",
  disputed: "⚠️ اطلاعات متناقض",
};

function sourceLinks(it: NewsItem, links: GroundedLink[]) {
  return it.sources
    .map((s) => {
      const d = s.toLowerCase().replace(/^www\./, "");
      const hit = links.find(
        (l) => l.domain === d || l.domain.endsWith("." + d) || d.endsWith("." + l.domain)
      );
      return hit ? `<a href="${escAttr(hit.url)}">${esc(d)}</a>` : esc(d);
    })
    .join(" • ");
}

export function formatNews(catId: string, win: WindowId, r: NewsResult, updatedAt: Date) {
  const cat = NEWS_CATEGORIES[catId];
  const time = updatedAt.toLocaleTimeString("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
  });
  const head = `${RLM}${cat.emoji} <b>${cat.label}</b> — ${WINDOWS[win].label}\n${RLM}🕒 بروزرسانی: ${time}`;

  if (r.items.length === 0) {
    return `${head}\n\n${RLM}در این بازه خبر مهم و قابل‌تأییدی پیدا نشد.`;
  }

  const blocks = r.items.map((it, i) => {
    const lines = [`${RLM}<b>${i + 1}. ${esc(it.title)}</b>`, `${RLM}${esc(it.summary)}`];
    if (it.why) lines.push(`${RLM}💡 ${esc(it.why)}`);
    lines.push(`${RLM}${STATUS_FA[it.status]}`);
    if (it.sources.length) lines.push(`${RLM}🔗 ${sourceLinks(it, r.links)}`);
    return lines.join("\n");
  });

  return [
    head,
    "",
    blocks.join("\n\n"),
    "",
    "<i>جمع‌بندی هوش مصنوعی از نتایج جستجو؛ برای موارد حساس منبع را بررسی کن.</i>",
  ].join("\n");
}