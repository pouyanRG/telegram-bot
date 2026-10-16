import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { cache } from "./schema";

const COINS = [
  { id: "bitcoin", symbol: "BTC" },
  { id: "ethereum", symbol: "ETH" },
  { id: "binancecoin", symbol: "BNB" },
  { id: "ripple", symbol: "XRP" },
  { id: "cardano", symbol: "ADA" },
  { id: "solana", symbol: "SOL" },
  { id: "dogecoin", symbol: "DOGE" },
  { id: "tron", symbol: "TRX" },
  { id: "sui", symbol: "SUI" },
  { id: "avalanche-2", symbol: "AVAX" },
  { id: "whitebit", symbol: "WBT" },
  { id: "leo-token", symbol: "LEO" },
  { id: "zcash", symbol: "ZEC" },
  { id: "hyperliquid", symbol: "HYPE" },
  { id: "monero", symbol: "XMR" },
  { id: "chainlink", symbol: "LINK" },
  { id: "the-open-network", symbol: "TON" }, // اگر منظورت از Gram چیز دیگری بود، id و symbol را عوض کن
];

const CACHE_KEY = "market"; // کلید جدید، چون ساختار داده عوض شده
const TTL_MS = 2 * 60 * 1000;

export type Snapshot = {
  coins: Record<string, { usd: number; usd_24h_change?: number }>;
  global?: { marketCap: number; volume: number; btcDom: number; ethDom: number; active: number };
  fng?: { value: number; label: string };
  usdtToman?: number;
};

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchSnapshot(): Promise<Snapshot> {
  const headers: Record<string, string> = {};
  if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  const ids = COINS.map((c) => c.id).join(",");

  const [coins, glob, fng, nobitex] = await Promise.allSettled([
    getJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
      headers
    ),
    getJson("https://api.coingecko.com/api/v3/global", headers),
    getJson("https://api.alternative.me/fng/"),
    getJson("https://api.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls"),
  ]);

  if (coins.status === "rejected") throw coins.reason; // بدون قیمت کوین‌ها پیام بی‌معنی است

  const snap: Snapshot = { coins: coins.value };

  if (glob.status === "fulfilled") {
    const g = glob.value.data;
    snap.global = {
      marketCap: g.total_market_cap.usd,
      volume: g.total_volume.usd,
      btcDom: g.market_cap_percentage.btc,
      ethDom: g.market_cap_percentage.eth,
      active: g.active_cryptocurrencies,
    };
  }
  if (fng.status === "fulfilled") {
    const d = fng.value.data?.[0];
    if (d) snap.fng = { value: Number(d.value), label: d.value_classification };
  }
  if (nobitex.status === "fulfilled") {
    const rial = Number(nobitex.value.stats?.["usdt-rls"]?.latest);
    if (rial > 0) snap.usdtToman = Math.round(rial / 10);
  }
  return snap;
}

export async function getPrices() {
  const db = getDb();
  const [row] = await db.select().from(cache).where(eq(cache.key, CACHE_KEY));

  if (row && Date.now() - row.updatedAt.getTime() < TTL_MS) {
    return { data: row.data as Snapshot, updatedAt: row.updatedAt };
  }

  try {
    const data = await fetchSnapshot();
    const now = new Date();
    await db
      .insert(cache)
      .values({ key: CACHE_KEY, data, updatedAt: now })
      .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: now } });
    return { data, updatedAt: now };
  } catch (e) {
    console.error("Market fetch error:", e);
    if (row) return { data: row.data as Snapshot, updatedAt: row.updatedAt };
    throw e;
  }
}

// ---------- قالب‌بندی ----------

const fmtPrice = (n: number) =>
  n >= 10000
    ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : n >= 0.01
      ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : n.toFixed(6);

function fmtUsd(n: number) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} تریلیون دلار`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} میلیارد دلار`;
  return `${(n / 1e6).toFixed(1)} میلیون دلار`;
}

const FNG_FA: Record<string, { text: string; icon: string }> = {
  "Extreme Fear": { text: "ترس شدید", icon: "🟥" },
  Fear: { text: "ترس", icon: "🟧" },
  Neutral: { text: "خنثی", icon: "🟨" },
  Greed: { text: "طمع", icon: "🟩" },
  "Extreme Greed": { text: "طمع شدید", icon: "🟩" },
};

export function formatPrices(s: Snapshot, _updatedAt?: Date) {
  const lines = COINS.map((c) => {
    const p = s.coins[c.id];
    if (!p) return `▫️ ${c.symbol}: —`;
    const ch = p.usd_24h_change;
    const arrow = ch === undefined || ch >= 0 ? "🔺" : "🔻";
    const pct = ch === undefined ? "" : ` (${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%)`;
    return `${arrow} ${c.symbol}: ${fmtPrice(p.usd)}${pct}`;
  });

  const out: string[] = ["📊 <b>آخرین وضعیت بازار</b>", "", ...lines, ""];

  if (s.global) {
    const g = s.global;
    out.push(`💰 مارکت‌کپ: ${fmtUsd(g.marketCap)}`);
    out.push(`🪙 آلت‌کوین‌ها: ${fmtUsd(g.marketCap * (1 - g.btcDom / 100))}`);
    out.push(`🔄 معاملات: ${fmtUsd(g.volume)}`);
    out.push(`🟠 دامیننس بیت‌کوین: ${g.btcDom.toFixed(2)}%`);
    out.push(`⚪️ دامیننس اتریوم: ${g.ethDom.toFixed(2)}%`);
  }
  if (s.fng) {
    const f = FNG_FA[s.fng.label] ?? { text: s.fng.label, icon: "⬜️" };
    out.push(`${f.icon} احساسات: ${s.fng.value} (${f.text})`);
  }
  if (s.global) out.push(`🟡 تعداد ارزهای فعال: ${s.global.active.toLocaleString("en-US")}+`);

  if (s.usdtToman) {
    out.push("", `💵 <b>قیمت تتر: ${s.usdtToman.toLocaleString("fa-IR")} تومان</b>`);
  }

  out.push("", "<blockquote>برای دریافت قیمت و مشخصات و نمودار ارزهای دیجیتال، نام یا نماد آن را ارسال کنید</blockquote>");
  return out.join("\n");
}