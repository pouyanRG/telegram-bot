import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { cache } from "./schema";

const IS_PROD = process.env.NODE_ENV === "production";
// پیشوند __Host- یعنی فقط Secure، بدون Domain و روی مسیر / (فقط در پروداکشن)
const COOKIE = IS_PROD ? "__Host-admin_session" : "admin_session";
const MAX_AGE = 60 * 60 * 8; // ۸ ساعت
const VERSION = "v1";

const MAX_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

// ---------- امضا ----------

function getKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set (at least 32 characters)");
  }
  // وابسته به رمز پنل: با عوض شدن رمز، همه‌ی نشست‌های قبلی باطل می‌شوند
  const pw = process.env.ADMIN_PASSWORD ?? "";
  return createHmac("sha256", secret).update(`admin-session-key|${pw}`).digest();
}

function sign(payload: string) {
  return createHmac("sha256", getKey()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- رمز عبور ----------

export function passwordMatches(input: string) {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected || input.length > 256) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// ---------- نشست ----------

export async function createAdminSession() {
  const exp = String(Date.now() + MAX_AGE * 1000);
  const payload = `${VERSION}.${exp}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function destroyAdminSession() {
  (await cookies()).set(COOKIE, "", {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

export async function isAdmin() {
  try {
    const raw = (await cookies()).get(COOKIE)?.value;
    if (!raw || raw.length > 200) return false;

    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) return false;

    const [, exp, sig] = parts;
    if (!safeEqual(sig, sign(`${VERSION}.${exp}`))) return false;

    const expiresAt = Number(exp);
    const now = Date.now();
    return (
      Number.isFinite(expiresAt) &&
      expiresAt > now &&
      expiresAt <= now + MAX_AGE * 1000 + 60_000
    );
  } catch (e) {
    console.error("isAdmin error:", e);
    return false;
  }
}

export async function requireAdmin() {
  if (!(await isAdmin())) redirect("/admin/login");
}

// ---------- قفل موقت بعد از تلاش‌های ناموفق ----------

type Attempts = { count: number; resetAt: number };

async function clientKey() {
  const h = await headers();
  const ip =
    h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return `admin_login:${ip.slice(0, 64)}`;
}

export async function getLoginLock() {
  try {
    const key = await clientKey();
    const [row] = await getDb().select().from(cache).where(eq(cache.key, key));
    const d = row?.data as Attempts | undefined;
    if (d && d.resetAt > Date.now() && d.count >= MAX_ATTEMPTS) {
      return { locked: true, retryAfterMin: Math.ceil((d.resetAt - Date.now()) / 60000) };
    }
  } catch (e) {
    // اگر دیتابیس در دسترس نبود، ورود قفل نشود
    console.error("getLoginLock error:", e);
  }
  return { locked: false, retryAfterMin: 0 };
}

export async function recordLoginFailure() {
  try {
    const key = await clientKey();
    const now = Date.now();
    const fresh: Attempts = { count: 1, resetAt: now + LOCK_WINDOW_MS };

    await getDb()
      .insert(cache)
      .values({ key, data: fresh })
      .onConflictDoUpdate({
        target: cache.key,
        set: {
          data: sql`case
            when (${cache.data}->>'resetAt')::bigint < ${now}::bigint
              then ${JSON.stringify(fresh)}::jsonb
            else jsonb_set(
              ${cache.data},
              '{count}',
              to_jsonb((${cache.data}->>'count')::int + 1)
            )
          end`,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    console.error("recordLoginFailure error:", e);
  }
}

export async function clearLoginFailures() {
  try {
    await getDb().delete(cache).where(eq(cache.key, await clientKey()));
  } catch (e) {
    console.error("clearLoginFailures error:", e);
  }
}