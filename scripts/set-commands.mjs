const { BOT_TOKEN } = process.env;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN must be set in .env.local");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    commands: [
      { command: "start", description: "شروع و منوی اصلی" },
      { command: "help", description: "راهنما" },
    ],
  }),
});

console.log(await res.json());
