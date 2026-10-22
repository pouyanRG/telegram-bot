import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

let _redis: Redis | null | undefined;

function redis() {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

type Kind = "general" | "relay";
let _limiters: Record<Kind, Ratelimit> | null = null;

function limiters() {
  const r = redis();
  if (!r) return null;
  return (_limiters ??= {
    // همه‌ی آپدیت‌ها (پیام، دکمه، ...)
    general: new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(10, "5 s"),
      prefix: "rl:g",
      timeout: 1000, // اگر Redis کند بود، اجازه بده (fail-open)
    }),
    // فقط پیام‌هایی که به طرف مقابل چت ناشناس فوروارد می‌شوند (سخت‌گیرانه‌تر)
    relay: new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(4, "2 s"),
      prefix: "rl:r",
      timeout: 1000,
    }),
  });
}

/** true یعنی اجازه دارد */
export async function checkRate(kind: Kind, userId: number) {
  try {
    const l = limiters();
    if (!l) return true; // Redis تنظیم نشده
    return (await l[kind].limit(String(userId))).success;
  } catch (e) {
    console.error("rateLimit error:", e instanceof Error ? e.message : "unknown");
    return true; // قطع Redis نباید ربات را از کار بیندازد
  }
}

/** فقط یک بار در ۳۰ ثانیه true می‌دهد تا خودمان اسپم هشدار نفرستیم */
export async function shouldWarn(userId: number) {
  try {
    const r = redis();
    if (!r) return false;
    return (await r.set(`rl:warn:${userId}`, 1, { nx: true, ex: 30 })) === "OK";
  } catch {
    return false;
  }
}

