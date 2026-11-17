import { createHmac } from "node:crypto";
import { count, desc, gte, sql, sum } from "drizzle-orm";
import { getDb } from "./db";
import { geminiKeys } from "./geminiKeys";
import { adminAuditLogs, operationalErrors, users } from "./schema";

type CheckResult = { status: "ok" | "warning" | "error"; detail: string; latencyMs?: number };

async function probe(name: string, run: () => Promise<string>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const detail = await run();
    const warning = detail.startsWith("WARN:");
    return {
      status: warning ? "warning" : "ok",
      detail: warning ? detail.slice("WARN:".length) : detail,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${name} unavailable`;
    const notConfigured = message.startsWith("NOT_CONFIGURED:");
    return {
      status: notConfigured ? "warning" : "error",
      detail: notConfigured ? message.slice("NOT_CONFIGURED:".length) : message.slice(0, 100),
      latencyMs: Date.now() - started,
    };
  }
}

async function httpCheck(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

export async function collectHealthChecks() {
  const db = probe("database", async () => {
    await getDb().execute(sql`select 1`);
    return "اتصال برقرار است";
  });

  const telegram = probe("telegram", async () => {
    const token = process.env.BOT_TOKEN;
    if (!token) throw new Error("BOT_TOKEN تنظیم نیست");
    const response = await httpCheck(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: { url?: string; pending_update_count?: number; last_error_message?: string };
    };
    if (!payload.ok || !payload.result) throw new Error("پاسخ Telegram نامعتبر است");
    const expectedUrl = process.env.APP_URL
      ? `${process.env.APP_URL.replace(/\/$/, "")}/api/webhook`
      : null;
    const matches = !expectedUrl || payload.result.url === expectedUrl;
    const queue = payload.result.pending_update_count ?? 0;
    const warning = !matches || Boolean(payload.result.last_error_message) || queue > 100;
    const detail = [
      matches ? "وبهوک ثبت است" : "هشدار: آدرس وبهوک با APP_URL هماهنگ نیست",
      `${queue} آپدیت معطل`,
      payload.result.last_error_message ? "هشدار: خطای اخیر ثبت شده" : "بدون خطای اخیر",
    ].join(" · ");
    return warning ? `WARN:${detail}` : detail;
  });

  const redis = probe("redis", async () => {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
    if (!url || !token) throw new Error("NOT_CONFIGURED:Upstash تنظیم نشده");
    const response = await httpCheck(`${url.replace(/\/$/, "")}/ping`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = (await response.json()) as { result?: string };
    if (payload.result !== "PONG") throw new Error("پاسخ Redis نامعتبر است");
    return "اتصال برقرار است";
  });

  const configuredGeminiKey = geminiKeys()[0];
  const gemini = probe("gemini", async () => {
    if (!configuredGeminiKey) throw new Error("NOT_CONFIGURED:کلید Gemini تنظیم نشده");
    await httpCheck("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": configuredGeminiKey },
    });
    return "API در دسترس است";
  });

  const coinGecko = probe("coingecko", async () => {
    await httpCheck("https://api.coingecko.com/api/v3/ping");
    return "API در دسترس است";
  });

  const results = await Promise.all([db, telegram, redis, gemini, coinGecko]);
  return {
    checks: [
      { name: "دیتابیس", result: results[0] },
      { name: "تلگرام و وبهوک", result: results[1] },
      { name: "Upstash Redis", result: results[2] },
      { name: "Gemini", result: results[3] },
      { name: "CoinGecko", result: results[4] },
    ],
    runtime: {
      uptimeSeconds: Math.floor(process.uptime()),
      checkedAt: new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }),
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? "محیط محلی",
    },
  };
}

function userReference(id: number) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET معتبر برای ناشناس‌سازی خروجی لازم است");
  return createHmac("sha256", secret).update(`export-user:${id}`).digest("hex").slice(0, 16);
}

function safeCsv(value: string | number | boolean) {
  const raw = String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function analyticsData() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [usersTotal, usersActive, usersBanned, actions, errors] = await Promise.all([
    getDb().select({ value: count() }).from(users),
    getDb().select({ value: count() }).from(users).where(gte(users.lastSeenAt, since)),
    getDb().select({ value: count() }).from(users).where(sql`${users.isBanned} = true`),
    getDb()
      .select({ action: adminAuditLogs.action, total: count() })
      .from(adminAuditLogs)
      .where(gte(adminAuditLogs.createdAt, since))
      .groupBy(adminAuditLogs.action)
      .orderBy(desc(count())),
    getDb()
      .select({
        source: operationalErrors.source,
        uniqueErrors: count(),
        occurrences: sum(operationalErrors.occurrences),
      })
      .from(operationalErrors)
      .where(gte(operationalErrors.lastSeenAt, since))
      .groupBy(operationalErrors.source)
      .orderBy(desc(sum(operationalErrors.occurrences))),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    periodDays: 30,
    users: {
      total: usersTotal[0]?.value ?? 0,
      activeLast30Days: usersActive[0]?.value ?? 0,
      currentlyBanned: usersBanned[0]?.value ?? 0,
    },
    adminActionsByType: actions.map((row) => ({ action: row.action, count: row.total })),
    operationalErrorsBySource: errors.map((row) => ({
      source: row.source,
      uniqueErrors: row.uniqueErrors,
      occurrences: Number(row.occurrences ?? 0),
    })),
  };
}

export async function buildAdminExport(kind: "users-csv" | "users-json" | "analytics") {
  if (kind === "analytics") {
    return {
      filename: `bot-analytics-${Date.now()}.json`,
      content: JSON.stringify(await analyticsData(), null, 2),
      description: "آمار تجمیعی ۳۰ روزه؛ بدون شناسهٔ کاربران",
    };
  }

  const MAX_ROWS = 10_000;
  const [total] = await getDb().select({ value: count() }).from(users);
  const rows = await getDb()
    .select({
      id: users.telegramId,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      isBanned: users.isBanned,
      proUntil: users.proUntil,
    })
    .from(users)
    .orderBy(users.telegramId)
    .limit(MAX_ROWS);

  const safeRows = rows.map((row) => ({
    userRef: userReference(row.id),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    banned: row.isBanned,
    proUntil: row.proUntil?.toISOString() ?? null,
  }));
  const note = `ردیف‌های خروجی: ${rows.length} از ${total.value}؛ شناسه‌ها و نام‌ها حذف/ناشناس‌سازی شده‌اند.`;

  if (kind === "users-csv") {
    const headers = ["user_ref", "created_at", "last_seen_at", "banned", "pro_until"];
    const content = [
      headers.join(","),
      ...safeRows.map((row) =>
        [
          row.userRef,
          row.createdAt,
          row.lastSeenAt,
          row.banned,
          row.proUntil ?? "",
        ].map(safeCsv).join(",")
      ),
    ].join("\r\n");
    return {
      filename: `bot-users-${Date.now()}.csv`,
      content,
      description: note,
    };
  }

  return {
    filename: `bot-users-${Date.now()}.json`,
    content: JSON.stringify({ generatedAt: new Date().toISOString(), note, users: safeRows }, null, 2),
    description: note,
  };
}
