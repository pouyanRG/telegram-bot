import { UserError } from "../errors";
import { WINDOWS, type NewsCategory, type WindowId } from "./categories";

export type NewsStatus = "confirmed" | "single" | "official_claim" | "disputed";

export type NewsItem = {
  title: string;
  summary: string;
  why: string;
  status: NewsStatus;
  publishedAt: string | null; // ISO UTC
  sources: string[]; // فقط دامنه، مثل reuters.com
};

export type GroundedLink = { domain: string; url: string };

const CORE = `You are a news research engine. Use Google Search to find REAL news. Rules:
- Only report news that you found through search. Never invent facts, sources, dates or links.
- Only include items published inside the requested time window. Use the current UTC time given below.
- Merge reports of the same event into ONE item; list all its sources. Separate genuinely new developments into separate items.
- Rank by importance, not by recency alone. Return at most {MAX} items.
- Distinguish old news republished today from new events.
- A single party's claim (government, army, company) is "official_claim" unless independent sources confirm it. Multiple sites repeating one origin do NOT count as independent confirmation.
- status must be one of: confirmed (multiple independent sources), single (one source), official_claim, disputed (conflicting reports).
- Write title, summary and why in Persian (Farsi). Keep summary under 2 sentences. "why" = one sentence on why it matters, clearly separate from facts.
- sources: bare domains only (e.g. "reuters.com").
- Output ONLY a JSON array, no markdown fences, no extra text. Item shape:
{"title":"","summary":"","why":"","status":"","publishedAt":"ISO-8601 UTC or null","sources":["domain"]}
- If nothing important was found, output [].`;

function buildPrompt(cat: NewsCategory, win: WindowId, maxItems: number) {
  const now = new Date();
  const from = new Date(now.getTime() - WINDOWS[win].hours * 3600_000);
  return [
    CORE.replace("{MAX}", String(maxItems)),
    "",
    `CATEGORY: ${cat.focus}`,
    `Keywords: ${cat.keywords.join(", ")}`,
    `Primary sources: ${cat.primarySources.join("; ")}`,
    `Media to prefer: ${cat.mediaSources.join(", ")}`,
    `What counts as important: ${cat.importance}`,
    `Verification rule: ${cat.verification}`,
    "",
    `Current UTC time: ${now.toISOString()}`,
    `Time window: from ${from.toISOString()} to ${now.toISOString()}`,
  ].join("\n");
}

function parseItems(text: string): NewsItem[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const STATUS = new Set(["confirmed", "single", "official_claim", "disputed"]);
  const out: NewsItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r?.title !== "string" || typeof r?.summary !== "string") continue;
    out.push({
      title: r.title.slice(0, 200),
      summary: r.summary.slice(0, 500),
      why: typeof r.why === "string" ? r.why.slice(0, 300) : "",
      status: STATUS.has(r.status as string) ? (r.status as NewsStatus) : "single",
      publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : null,
      sources: Array.isArray(r.sources)
        ? (r.sources as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 4)
        : [],
    });
  }
  return out;
}

export async function searchNews(cat: NewsCategory, win: WindowId, maxItems = 6) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!key || !model) throw new Error("GEMINI_API_KEY and GEMINI_MODEL must be set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(cat, win, maxItems) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 3000 },
      }),
      signal: AbortSignal.timeout(45_000),
    }
  );

  if (res.status === 429) {
    throw new UserError(
      "⏳ سرویس خبر الان شلوغ است. چند دقیقه بعد دوباره امتحان کن. (سهمیه‌ات کسر نشد)"
    );
  }
  if (!res.ok) throw new Error(`gemini news http ${res.status}`);

  const json = await res.json();
  const cand = json?.candidates?.[0];
  const text = ((cand?.content?.parts ?? []) as { text?: string }[])
    .map((p) => p.text ?? "")
    .join("");

  // لینک‌ها فقط از نتایجی که واقعاً جستجو برگردانده (نه از ساخته‌ی مدل)
  const chunks = (cand?.groundingMetadata?.groundingChunks ?? []) as {
    web?: { uri?: string; title?: string };
  }[];
  const links: GroundedLink[] = chunks
    .filter((c) => c.web?.uri?.startsWith("https://") && c.web?.title)
    .map((c) => ({ domain: c.web!.title!.toLowerCase(), url: c.web!.uri! }));

  return { items: parseItems(text), links };
}