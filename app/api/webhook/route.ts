import { webhookCallback } from "grammy";
import { getBot } from "@/lib/bot";
import { isAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const handler = webhookCallback(getBot(), "std/http", {
    secretToken: process.env.WEBHOOK_SECRET,
  });
  return handler(req);
}

export async function GET(req: Request) {
  const { BOT_TOKEN, WEBHOOK_SECRET } = process.env;
  const { origin } = new URL(req.url);

  if (!(await isAdmin())) {
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

  const cmdRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "start", description: "شروع و منوی اصلی" },
        { command: "menu", description: "نمایش منو" },
        { command: "prices", description: "قیمت ارز و طلا" },
        { command: "help", description: "راهنما" },
      ],
    }),
  });

  return Response.json({
    webhookUrl: url,
    set: await setRes.json(),
    info: await infoRes.json(),
    commands: await cmdRes.json(),
  });
}