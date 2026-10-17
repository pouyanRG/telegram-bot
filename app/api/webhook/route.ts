import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { webhookCallback } from "grammy";
import type { Update } from "grammy/types";
import { getBot } from "@/lib/bot";
import { isAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // سقف پلن Hobby؛ اگر پلن بالاتر داری می‌توانی بیشترش کنی

// آپدیت‌های تلگرام کوچک‌اند؛ بدنه‌ی خیلی بزرگ قطعاً جعلی است
const MAX_BODY_BYTES = 1_000_000;

// فقط همین نوع آپدیت‌ها را از تلگرام بگیر (ترافیک کمتر)
// اگر بعداً inline_query یا چیز دیگری اضافه کردی، اینجا هم اضافه کن
const ALLOWED_UPDATES = ["message", "callback_query"];

// حالت «اول تأیید، بعد پردازش»:
// فوراً 200 به تلگرام می‌دهد و کار اصلی بعد از پاسخ ادامه پیدا می‌کند.
// نتیجه: تلگرام هیچ‌وقت به‌خاطر کند بودن (ویس طولانی) آپدیت را دوباره نمی‌فرستد.
// پیش‌فرض خاموش است؛ با WEBHOOK_ACK_FIRST=1 روشن می‌شود.
const ACK_FIRST = process.env.WEBHOOK_ACK_FIRST === "1";

// ---------- ابزارها ----------

function secretOk(req: Request, secret: string) {
  const got = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") ?? "");
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

let _handler: ((req: Request) => Promise<Response>) | null = null;

function classicHandler() {
  return (_handler ??= webhookCallback(getBot(), "std/http", {
    secretToken: process.env.WEBHOOK_SECRET,
    timeoutMilliseconds: 55_000,
    // اگر پردازش طولانی شد، 200 بده تا تلگرام آپدیت را تکرار نکند
    onTimeout: "return",
  }));
}

async function ackFirst(req: Request) {
  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!update || typeof update.update_id !== "number") {
    return new Response("Bad request", { status: 400 });
  }

  after(async () => {
    const t0 = Date.now();
    try {
      const bot = getBot();
      await bot.init(); // فقط بار اول getMe می‌زند
      await bot.handleUpdate(update);
    } catch (e) {
      console.error("webhook(after) error:", e instanceof Error ? e.message : "unknown");
    } finally {
      console.log(`update ${update.update_id} done in ${Date.now() - t0}ms`);
    }
  });

  return new Response("ok");
}

// ---------- دریافت آپدیت‌ها از تلگرام ----------

export async function POST(req: Request) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return new Response("Server misconfigured", { status: 500 });

  // ۱) رد سریع درخواست‌های جعلی، قبل از هر کار سنگین (بدون ساختن ربات/اتصال دیتابیس)
  if (!secretOk(req, secret)) return new Response("Unauthorized", { status: 401 });

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });

  // ۲) پردازش
  try {
    return ACK_FIRST ? await ackFirst(req) : await classicHandler()(req);
  } catch (e) {
    // اگر 5xx برگردد، تلگرام همان آپدیت را بارها دوباره می‌فرستد (و پیام‌ها تکراری پردازش می‌شوند)
    console.error("webhook error:", e instanceof Error ? e.message : "unknown");
    return new Response("ok", { status: 200 });
  }
}

// ---------- ابزار تشخیص برای ادمین ----------
// GET /api/webhook            → فقط وضعیت را نشان می‌دهد
// GET /api/webhook?set=1      → وبهوک را ثبت می‌کند
// GET /api/webhook?set=1&drop=1 → ثبت + حذف آپدیت‌های معلق‌مانده

type Tg = { ok: boolean; result?: Record<string, unknown>; description?: string };

async function tg(token: string, method: string, body?: unknown): Promise<Tg> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.json()) as Tg;
  } catch {
    // پیام خطای fetch ممکن است شامل آدرس (و توکن) باشد؛ برنگردان
    return { ok: false, description: "request to Telegram failed" };
  }
}

export async function GET(req: Request) {
  if (!(await isAdmin())) return new Response("Unauthorized", { status: 401 });

  const { BOT_TOKEN, WEBHOOK_SECRET, APP_URL } = process.env;
  if (!BOT_TOKEN || !WEBHOOK_SECRET) {
    return Response.json({ error: "BOT_TOKEN or WEBHOOK_SECRET missing" }, { status: 500 });
  }

  const reqUrl = new URL(req.url);
  const base = (APP_URL || reqUrl.origin).replace(/\/$/, "");
  const url = `${base}/api/webhook`;

  if (!url.startsWith("https://")) {
    return Response.json({ error: "Telegram needs an https URL", url }, { status: 400 });
  }

  let setResult: Tg | null = null;
  if (reqUrl.searchParams.get("set") === "1") {
    setResult = await tg(BOT_TOKEN, "setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: reqUrl.searchParams.get("drop") === "1",
    });
  }

  const [info, me] = await Promise.all([
    tg(BOT_TOKEN, "getWebhookInfo"),
    tg(BOT_TOKEN, "getMe"),
  ]);

  const i = info.result ?? {};
  const urlMatches = i.url === url;
  const lastError = (i.last_error_message as string | undefined) ?? null;

  return Response.json({
    healthy: info.ok && urlMatches && !lastError,
    mode: ACK_FIRST ? "ack-first" : "classic",
    bot: me.ok ? { id: me.result?.id, username: me.result?.username } : null,
    expectedUrl: url,
    urlMatches,
    pendingUpdates: i.pending_update_count ?? null,
    lastError,
    lastErrorAt:
      typeof i.last_error_date === "number"
        ? new Date(i.last_error_date * 1000).toISOString()
        : null,
    set: setResult,
    hint: urlMatches ? undefined : "وبهوک روی آدرس درست نیست؛ با ?set=1 ثبتش کن.",
  });
}