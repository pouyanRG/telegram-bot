import { createHash } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { ownerId } from "./admins";
import { operationalErrors } from "./schema";

const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

function safeMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[token]")
    .replace(/\b(password|token|secret|api[_-]?key)\s*[=:]\s*[^,\s;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500) || "Unknown error";
}

export async function logOperationalError(source: string, error: unknown, severity = "error") {
  const message = safeMessage(error);
  const fingerprint = createHash("sha256")
    .update(`${source}:${message}`)
    .digest("hex");

  try {
    const [row] = await getDb()
      .insert(operationalErrors)
      .values({ fingerprint, source: source.slice(0, 80), severity, message })
      .onConflictDoUpdate({
        target: operationalErrors.fingerprint,
        set: {
          occurrences: sql`${operationalErrors.occurrences} + 1`,
          lastSeenAt: new Date(),
          resolvedAt: null,
        },
      })
      .returning({
        id: operationalErrors.id,
        occurrences: operationalErrors.occurrences,
      });

    const owner = ownerId();
    if (!owner || !row) return;

    const eligible = await getDb()
      .update(operationalErrors)
      .set({ lastNotifiedAt: new Date() })
      .where(
        and(
          eq(operationalErrors.id, row.id),
          or(
            isNull(operationalErrors.lastNotifiedAt),
            lt(
              operationalErrors.lastNotifiedAt,
              new Date(Date.now() - ALERT_COOLDOWN_MS)
            )
          )
        )
      )
      .returning({ id: operationalErrors.id });
    if (!eligible.length) return;

    const token = process.env.BOT_TOKEN;
    if (!token) {
      console.error("operational alert skipped: BOT_TOKEN is not configured");
      return;
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: owner,
        text: `🚨 خطای ${severity}\nمنبع: ${source.slice(0, 80)}\nتکرار: ${row.occurrences}\n${message}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error("operational alert delivery failed:", response.status);
    }
  } catch (loggingError) {
    console.error(
      "operational error logging failed:",
      safeMessage(loggingError)
    );
  }
}
