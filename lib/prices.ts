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
  { id: "the-open-network", symbol: "TON" },
];

const CACHE_KEY = "market";
const TTL_MS = 2 * 60 * 1000;

export type Snapshot = {
  coins: Record<string, { usd: number; usd_24h_change?: number }>;
  global?: { marketCap: number; volume: number; btcDom: number; ethDom: number; active: number };
  fng?: { value: number; label: string };
  usdtToman?: number;
};

// ---------- دریافت داده ----------

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function cgHeaders() {
  const h: Record<string, string> = {};
  if (process.env.COINGECKO_API_KEY) h["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  return h;
}

async function fetchSnapshot(): Promise<Snapshot> {
  const headers = cgHeaders();
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

  if (coins.status === "rejected") throw coins.reason;

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

// ---------- ابزارهای قالب‌بندی ----------

// طبق مستندات تلگرام: < > & باید escape شوند
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const RLM = "\u200F"; // برای راست‌چین ماندن خط‌های فارسی

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

const pctText = (ch?: number) =>
  ch === undefined ? "" : `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`;

function gauge(v: number) {
  const filled = Math.max(0, Math.min(10, Math.round(v / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

const FNG_FA: Record<string, { text: string; icon: string }> = {
  "Extreme Fear": { text: "ترس شدید", icon: "🟥" },
  Fear: { text: "ترس", icon: "🟧" },
  Neutral: { text: "خنثی", icon: "🟨" },
  Greed: { text: "طمع", icon: "🟩" },
  "Extreme Greed": { text: "طمع شدید", icon: "🟩" },
};

// ---------- پیام بازار (parse_mode: HTML) ----------

export function formatPrices(s: Snapshot, updatedAt?: Date) {
  const rows = COINS.map((c) => ({ symbol: c.symbol, p: s.coins[c.id] })).filter(
    (r) => r.p
  );

  // جدول تراز‌شده (داخل <pre>)
  const table = rows
    .map(({ symbol, p }) => {
      const ch = p.usd_24h_change;
      const dot = ch === undefined ? "⚪️" : ch >= 0 ? "🟢" : "🔴";
      return `${dot} ${esc(symbol).padEnd(5)} ${("$" + fmtPrice(p.usd)).padStart(11)} ${pctText(ch).padStart(8)}`;
    })
    .join("\n");

  // برترین رشد و افت
  const sorted = rows
    .filter((r) => r.p.usd_24h_change !== undefined)
    .sort((a, b) => b.p.usd_24h_change! - a.p.usd_24h_change!);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  const time = (updatedAt ?? new Date()).toLocaleTimeString("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
  });

  const out: string[] = [
    `${RLM}📊 <b>وضعیت بازار ارزهای دیجیتال</b>`,
    `${RLM}🕒 بروزرسانی: ${time}`,
    "",
    `<pre>${table}</pre>`,
  ];

   // اسپویلر: فقط مقدار مخفی است و برچسب دیده می‌شود
  if (best && worst && best.symbol !== worst.symbol) {
    const LRM = "\u200E"; // برای جلوگیری از به‌هم‌ریختگی متن انگلیسی داخل جمله‌ی فارسی
    const worstCh = worst.p.usd_24h_change!;
    const worstLabel = worstCh < 0 ? "بیشترین افت" : "کمترین رشد";
    const worstIcon = worstCh < 0 ? "🩸" : "🐢";

    out.push(
      "",
      `${RLM}🎯 <b>برترین‌های ۲۴ ساعت</b> <i>(برای دیدن لمس کن)</i>`,
      `${RLM}🚀 بیشترین رشد: <tg-spoiler>${LRM}${esc(best.symbol)} ${pctText(best.p.usd_24h_change)}${LRM}</tg-spoiler>`,
      `${RLM}${worstIcon} ${worstLabel}: <tg-spoiler>${LRM}${esc(worst.symbol)} ${pctText(worstCh)}${LRM}</tg-spoiler>`
    );
  }

  // نمای کلی بازار: بلاک‌کوت جمع‌شونده (داخل آن هیچ بلاک‌کوت یا pre دیگری نیست)
  if (s.global) {
    const g = s.global;
    out.push(
      "",
      [
        `<blockquote expandable>${RLM}🌐 <b>نمای کلی بازار</b>`,
        `${RLM}💰 مارکت‌کپ: ${fmtUsd(g.marketCap)}`,
        `${RLM}🪙 آلت‌کوین‌ها: ${fmtUsd(g.marketCap * (1 - g.btcDom / 100))}`,
        `${RLM}🔄 حجم معاملات: ${fmtUsd(g.volume)}`,
        `${RLM}🟠 دامیننس بیت‌کوین: ${g.btcDom.toFixed(2)}%`,
        `${RLM}⚪️ دامیننس اتریوم: ${g.ethDom.toFixed(2)}%`,
        `${RLM}🟡 ارزهای فعال: ${g.active.toLocaleString("en-US")}+</blockquote>`,
      ].join("\n")
    );
  }

  if (s.fng) {
    const f = FNG_FA[s.fng.label] ?? { text: esc(s.fng.label), icon: "⬜️" };
    const filled = Math.max(0, Math.min(10, Math.round(s.fng.value / 10)));
    out.push(
      "",
      `${RLM}${f.icon} <b>شاخص ترس و طمع:</b> ${s.fng.value} از ۱۰۰ (${f.text})`,
      `${RLM}${"🟩".repeat(filled)}${"⬜".repeat(10 - filled)}`
    );
  }

  if (s.usdtToman) {
    out.push("", `${RLM}💵 <b>قیمت تتر: ${s.usdtToman.toLocaleString("fa-IR")} تومان</b>`);
  }

  out.push(
    "",
    "<blockquote>برای دریافت قیمت و مشخصات و نمودار ارزهای دیجیتال، نام یا نماد آن را ارسال کنید</blockquote>"
  );
  return out.join("\n");
}

// ---------- جستجوی تک‌ارز ----------

export type CoinInfo = {
  id: string;
  name: string;
  symbol: string;
  usd: number;
  change24h?: number;
  high24h?: number;
  low24h?: number;
  marketCap?: number;
  volume24h?: number;
  rank?: number;
};

const coinMemo = new Map<string, { at: number; value: CoinInfo | null }>();
const COIN_TTL_MS = 60 * 1000;

async function marketsById(id: string): Promise<CoinInfo | null> {
  const arr = await getJson(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}`,
    cgHeaders()
  );
  const d = arr?.[0];
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    symbol: String(d.symbol).toUpperCase(),
    usd: d.current_price,
    change24h: d.price_change_percentage_24h ?? undefined,
    high24h: d.high_24h ?? undefined,
    low24h: d.low_24h ?? undefined,
    marketCap: d.market_cap ?? undefined,
    volume24h: d.total_volume ?? undefined,
    rank: d.market_cap_rank ?? undefined,
  };
}

export async function findCoin(
  query: string,
  opts: { byId?: boolean } = {}
): Promise<CoinInfo | null> {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const key = `${opts.byId ? "id" : "q"}:${q}`;
  const hit = coinMemo.get(key);
  if (hit && Date.now() - hit.at < COIN_TTL_MS) return hit.value;

  let value: CoinInfo | null = null;

  if (opts.byId) {
    value = await marketsById(q);
  } else {
    const known = COINS.find((c) => c.symbol.toLowerCase() === q || c.id === q);
    let id = known?.id;
    if (!id) {
      const r = await getJson(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`,
        cgHeaders()
      );
      id = r?.coins?.[0]?.id;
    }
    if (id) value = await marketsById(id);
  }

  coinMemo.set(key, { at: Date.now(), value });
  return value;
}

export function formatCoin(c: CoinInfo) {
  const ch = c.change24h;
  const dot = ch === undefined ? "⚪️" : ch >= 0 ? "🟢" : "🔴";

  const out: string[] = [
    `${RLM}🪙 <b>${esc(c.name)}</b> (${esc(c.symbol)})${c.rank ? `  •  رتبه #${c.rank}` : ""}`,
    "",
    "<pre>" +
      [
        `Price : $${fmtPrice(c.usd)}`,
        ch === undefined ? "" : `24h   : ${pctText(ch)} ${dot}`,
        c.high24h !== undefined ? `High  : $${fmtPrice(c.high24h)}` : "",
        c.low24h !== undefined ? `Low   : $${fmtPrice(c.low24h)}` : "",
      ]
        .filter(Boolean)
        .join("\n") +
      "</pre>",
  ];

  const extra: string[] = [];
  if (c.marketCap) extra.push(`${RLM}💰 مارکت‌کپ: ${fmtUsd(c.marketCap)}`);
  if (c.volume24h) extra.push(`${RLM}🔄 حجم ۲۴ ساعت: ${fmtUsd(c.volume24h)}`);
  if (extra.length) out.push("", `<blockquote>${extra.join("\n")}</blockquote>`);

  return out.join("\n");
}