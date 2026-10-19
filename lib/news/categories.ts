export type WindowId = "1" | "3" | "24";

export type NewsCategory = {
  id: string;
  label: string;
  emoji: string;
  /** برای ساخت پرامپت (انگلیسی، کوتاه، ارزان‌تر در توکن) */
  focus: string;
  keywords: string[];
  primarySources: string[];
  mediaSources: string[];
  importance: string;
  verification: string;
  /** عمر کش به دقیقه، بر اساس بازه */
  ttlMin: Record<WindowId, number>;
};

export const WINDOWS: Record<WindowId, { label: string; hours: number }> = {
  "1": { label: "۱ ساعت اخیر", hours: 1 },
  "3": { label: "۳ ساعت اخیر", hours: 3 },
  "24": { label: "۲۴ ساعت اخیر", hours: 24 },
};

export const NEWS_CATEGORIES: Record<string, NewsCategory> = {
  war: {
    id: "war",
    label: "جنگ و امنیت",
    emoji: "⚔️",
    focus:
      "armed conflicts, military developments, negotiations, ceasefires, weapons, regional security (Middle East focus)",
    keywords: ["war", "attack", "ceasefire", "negotiations", "IDF", "Iran", "strike"],
    primarySources: ["official government and military statements", "defense ministries"],
    mediaSources: [
      "Reuters",
      "AP",
      "BBC",
      "Times of Israel",
      "Haaretz",
      "Iran International",
      "BBC Persian",
      "IRNA",
      "Tasnim",
    ],
    importance:
      "battlefield change, escalation, agreement or ceasefire, new official statement, civilian impact",
    verification:
      "Treat any single party's military claim as 'official_claim' unless independent sources confirm it. Compare sources with opposing viewpoints.",
    ttlMin: { "1": 5, "3": 10, "24": 30 },
  },
  tech: {
    id: "tech",
    label: "تکنولوژی و هوش مصنوعی",
    emoji: "💻",
    focus: "AI, software, phones, tech companies, cybersecurity, startups",
    keywords: ["AI", "launch", "release", "vulnerability", "startup", "model"],
    primarySources: [
      "official company blogs",
      "product announcements",
      "documentation",
      "security advisories",
    ],
    mediaSources: ["The Verge", "TechCrunch", "Ars Technica", "Wired", "Reuters", "Bloomberg"],
    importance:
      "new product or model release, security vulnerability, major funding or acquisition, regulation",
    verification:
      "Prefer the company's own announcement for specs and dates; flag rumors and leaks as unconfirmed.",
    ttlMin: { "1": 15, "3": 30, "24": 90 },
  },
};

export const NEWS_CATEGORY_IDS = Object.keys(NEWS_CATEGORIES);