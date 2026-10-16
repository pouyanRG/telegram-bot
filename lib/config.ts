// ---------- قابلیت‌ها و سهمیه‌ی روزانه ----------

export const FEATURES = {
  assistant: { label: "دستیار شخصی", emoji: "🧠", limit: 10 },
  persona: { label: "شخصیت‌ها", emoji: "🎭", limit: 10 },
  voice: { label: "ویس به متن", emoji: "🎙", limit: 5 },
  news: { label: "خبر شخصی", emoji: "📰", limit: 3 },
  coin: { label: "جستجوی ارز", emoji: "🪙", limit: 30 },
} as const;

export type Feature = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

// سقف پیش‌فرض را می‌شود با متغیر محیطی عوض کرد: LIMIT_VOICE=20 .
function resolveLimit(feature: Feature): number {
  const raw = process.env[`LIMIT_${feature.toUpperCase()}`];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : FEATURES[feature].limit;
}

export const LIMITS: Record<Feature, number> = Object.fromEntries(
  FEATURE_KEYS.map((f) => [f, resolveLimit(f)])
) as Record<Feature, number>;

// ---------- تنظیمات عمومی ----------

export const SETTINGS = {
  // مدت اعتبار کش قیمت‌ها در دیتابیس
  pricesTtlMs: 2 * 60 * 1000,
  // مدت اعتبار کش حافظه‌ای جستجوی تک‌ارز
  coinTtlMs: 60 * 1000,
  // تایم‌اوت درخواست به APIهای بیرونی
  fetchTimeoutMs: 8000,
  // ورودی‌ای که به‌عنوان نام/نماد ارز بررسی می‌شود
  coinQueryPattern: /^[A-Za-z0-9 .\-]{1,30}$/,
  // حداکثر ردیف جدول ادمین
  adminPageSize: 50,
} as const;

// ---------- ابزارهای کمکی ----------

export function featureLabel(feature: Feature) {
  const f = FEATURES[feature];
  return `${f.emoji} ${f.label}`;
}

// ریست سهمیه با تاریخ UTC انجام می‌شود (هماهنگ با quota.ts)
export function msUntilQuotaReset(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return next - now.getTime();
}

export function formatResetIn(now = new Date()) {
  const mins = Math.ceil(msUntilQuotaReset(now) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} دقیقه`;
  return m === 0 ? `${h} ساعت` : `${h} ساعت و ${m} دقیقه`;
}

export function quotaExceededMessage(feature: Feature) {
  return [
    `⏳ سهمیه‌ی امروز <b>${featureLabel(feature)}</b> تمام شد.`,
    `سقف روزانه: ${LIMITS[feature]} بار`,
    `ریست سهمیه: ${formatResetIn()} دیگر`,
  ].join("\n");
}