import { timingSafeEqual } from "node:crypto";
import { deletePriceAlert, getAllPriceAlerts } from "@/lib/crypto";
import { getCoinPrices } from "@/lib/prices";
import { getBot } from "@/lib/bot";
import { isFeatureEnabled } from "@/lib/adminControls";
import { logOperationalError } from "@/lib/operationalErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function formatPrice(price: number) {
  return `$${price.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (!isAuthorized(request)) return new Response("Unauthorized", { status: 401 });

  try {
    if (!(await isFeatureEnabled("coin"))) {
      return Response.json({ ok: true, disabled: true, notified: 0 });
    }

    const alerts = await getAllPriceAlerts();
    if (!alerts.length) return Response.json({ ok: true, checked: 0, notified: 0 });

    const prices = await getCoinPrices(alerts.map(({ alert }) => alert.coin.id));
    const bot = getBot();
    let notified = 0;
    let deliveryError: unknown = null;

    for (const { userId, alert } of alerts) {
      const currentPrice = prices[alert.coin.id]?.usd;
      if (currentPrice === undefined) continue;
      const reached = alert.direction === "above" ? currentPrice >= alert.price : currentPrice <= alert.price;
      if (!reached) continue;

      const direction = alert.direction === "above" ? "به بالاتر از" : "به پایین‌تر از";
      const text = `🔔 هشدار قیمت ${alert.coin.name} (${alert.coin.symbol})\nقیمت ${direction} ${formatPrice(alert.price)} رسید.\nقیمت فعلی: ${formatPrice(currentPrice)}`;
      try {
        await bot.api.sendMessage(userId, text, {
          reply_markup: { inline_keyboard: [[{ text: "💰 مشاهدهٔ بازار", callback_data: "menu:prices" }]] },
        });
        await deletePriceAlert(userId, alert.id);
        notified += 1;
      } catch (error) {
        const code = error && typeof error === "object" && "error_code" in error
          ? error.error_code
          : null;
        if (code === 403) {
          await deletePriceAlert(userId, alert.id);
          console.warn("crypto alert removed for a user who blocked the bot");
        } else {
          deliveryError ??= error;
          console.error("crypto alert delivery failed:", error instanceof Error ? error.message : "unknown");
        }
      }
    }

    if (deliveryError) throw deliveryError;
    return Response.json({ ok: true, checked: alerts.length, notified });
  } catch (error) {
    console.error("crypto alert cron failed:", error instanceof Error ? error.message : "unknown");
    await logOperationalError("crypto.alert.cron", error);
    return Response.json({ error: "Crypto alert processing failed" }, { status: 503 });
  }
}