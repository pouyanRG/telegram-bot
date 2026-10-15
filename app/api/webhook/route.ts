import { webhookCallback } from "grammy";
import { getBot } from "@/lib/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const handler = webhookCallback(getBot(), "std/http", {
    secretToken: process.env.WEBHOOK_SECRET,
  });
  return handler(req);
}

export async function GET(req: Request) {
  const { BOT_TOKEN, WEBHOOK_SECRET, ADMIN_PASSWORD } = process.env;
  const { searchParams, origin } = new URL(req.url);

  if (!ADMIN_PASSWORD || searchParams.get("password") !== ADMIN_PASSWORD) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!BOT_TOKEN || !WEBHOOK_SECRET) {
    return Response.json({ error: "BOT_TOKEN or WEBHOOK_SECRET missing" }, { status: 500 });
  }

  const url = `${origin}/api/webhook`;

  const setRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: WEBHOOK_SECRET }),
  });
  const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);

  return Response.json({
    webhookUrl: url,
    set: await setRes.json(),
    info: await infoRes.json(),
  });
}