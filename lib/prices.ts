import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { cache } from "./schema";

const COINS = [
  { id: "bitcoin", label: "₿ بیت‌کوین" },
  { id: "ethereum", label: "Ξ اتریوم" },
  { id: "tether", label: "💵 تتر" },
  { id: "the-open-network", label: "💎 تون‌کوین" },
  { id: "solana", label: "◎ سولانا" },
  { id: "pax-gold", label: "🥇 طلا (هر اونس)" },
];

const TTL_MS = 2 * 60 * 1000; // کش ۲ دقیقه‌ای

export type PriceData = Record<string, { usd: number; usd_24h_change?: number }>;

async function fetchPrices(): Promise<PriceData> {
  const ids = COINS.map((c) => c.id).join(",");
  const headers: Record<string, string> = {};
  if (process.env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  }
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
    { headers, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
}

export async function getPrices() {
  const db = getDb();
  const [row] = await db.select().from(cache).where(eq(cache.key, "prices"));

  if (row && Date.now() - row.updatedAt.getTime() < TTL_MS) {
    return { data: row.data as PriceData, updatedAt: row.updatedAt };
  }

  try {
    const data = await fetchPrices();
    const now = new Date();
    await db
      .insert(cache)
      .values({ key: "prices", data, updatedAt: now })
      .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: now } });
    return { data, updatedAt: now };
  } catch (e) {
    console.error("Prices fetch error:", e);
    if (row) return { data: row.data as PriceData, updatedAt: row.updatedAt }; // نسخه‌ی قدیمی بهتر از خطاست
    throw e;
  }
}

export function formatPrices(data: PriceData, updatedAt: Date) {
  const lines = COINS.map((c) => {
    const p = data[c.id];
    if (!p) return `${c.label}: —`;
    const ch = p.usd_24h_change;
    const arrow = ch === undefined ? "" : ch >= 0 ? ` 🟢 ${ch.toFixed(2)}%` : ` 🔴 ${ch.toFixed(2)}%`;
    const price = p.usd >= 1 ? p.usd.toLocaleString("en-US", { maximumFractionDigits: 2 }) : p.usd.toFixed(4);
    return `${c.label}: $${price}${arrow}`;
  });
  const time = updatedAt.toISOString().slice(11, 16);
  return `💰 قیمت‌ها (دلار)\n\n${lines.join("\n")}\n\n🕒 آخرین بروزرسانی: ${time} UTC`;
}
