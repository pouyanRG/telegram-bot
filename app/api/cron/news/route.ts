import { timingSafeEqual } from "node:crypto";
import {
  formatNewsItem,
  getNewsAlertCursor,
  getNewsAlertSubscribers,
  getNewsUserState,
  markNewsDelivered,
  refreshNewsFeed,
  setNewsAlertCursor,
  setNewsAlertsEnabled,
} from "@/lib/news";
import { getBot } from "@/lib/bot";
import { isFeatureEnabled } from "@/lib/adminControls";

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

function telegramErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("error_code" in error)) return null;
  const code = error.error_code;
  return typeof code === "number" ? code : null;
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (!isAuthorized(request)) return new Response("Unauthorized", { status: 401 });

  try {
    if (!(await isFeatureEnabled("news"))) {
      return Response.json({ ok: true, disabled: true, notified: 0 });
    }
    const [cursor, feed] = await Promise.all([getNewsAlertCursor(), refreshNewsFeed()]);
    const currentIds = feed.stories.map((story) => story.id);
    if (!cursor) {
      await setNewsAlertCursor(currentIds);
      return Response.json({ ok: true, initialized: true, notified: 0 });
    }

    const previousIds = new Set(cursor);
    const newStories = feed.stories.filter((story) => !previousIds.has(story.id));
    const subscribers = await getNewsAlertSubscribers();
    const bot = getBot();
    let notified = 0;
    let deliveryError: unknown = null;

    for (const story of newStories) {
      for (const subscriber of subscribers) {
        if (!subscriber.selected.includes(story.categoryId)) continue;
        const state = await getNewsUserState(subscriber.userId);
        if (state.deliveredIds.includes(story.id)) continue;
        const text = formatNewsItem(story, 0, 1, story.imageUrl ? 1024 : 4096);
        const options = {
          parse_mode: "HTML" as const,
          disable_notification: true,
          reply_markup: { inline_keyboard: [[{ text: "📰 خبرهای بیشتر", callback_data: "menu:news" }]] },
        };
        try {
          if (story.imageUrl) {
            try {
              await bot.api.sendPhoto(subscriber.userId, story.imageUrl, { caption: text, ...options });
            } catch (error) {
              if (telegramErrorCode(error) !== 400) throw error;
              await bot.api.sendMessage(subscriber.userId, text, options);
            }
          } else {
            await bot.api.sendMessage(subscriber.userId, text, options);
          }
          await markNewsDelivered(subscriber.userId, story.id);
          notified += 1;
        } catch (error) {
          if (telegramErrorCode(error) === 403) {
            await setNewsAlertsEnabled(subscriber.userId, false);
            console.warn("news alerts disabled for a user who blocked the bot");
          } else {
            deliveryError ??= error;
            console.error("news alert delivery failed:", error instanceof Error ? error.message : "unknown");
          }
        }
      }
    }

    if (deliveryError) throw deliveryError;
    await setNewsAlertCursor(currentIds);
    return Response.json({ ok: true, newStories: newStories.length, notified });
  } catch (error) {
    console.error("news alert cron failed:", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "News alert processing failed" }, { status: 503 });
  }
}
