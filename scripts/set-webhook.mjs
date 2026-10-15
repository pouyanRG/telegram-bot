const { BOT_TOKEN, WEBHOOK_SECRET, APP_URL } = process.env;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !APP_URL) {
  console.error("BOT_TOKEN, WEBHOOK_SECRET and APP_URL must be set in .env.local");
  process.exit(1);
}

const url = `${APP_URL.replace(/\/$/, "")}/api/webhook`;
const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url, secret_token: WEBHOOK_SECRET }),
});

console.log(await res.json());
