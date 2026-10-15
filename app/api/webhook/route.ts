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