import { InlineKeyboard } from "grammy";

export function mainMenu(isAdmin = false) {
  const kb = new InlineKeyboard()
    .text("🧠 دستیار شخصی", "menu:assistant")
    .row()
    .text("🎭 شخصیت‌ها", "menu:persona")
    .text("🎙 ویس به متن", "menu:voice")
    .row()
    .text("📰 خبر شخصی", "menu:news")
    .text("💰 قیمت‌ها", "menu:prices")
    .row()
    .text("ℹ️ راهنما", "menu:help");

  // فقط برای ادمین‌ها
  if (isAdmin) kb.row().text("⚙️ Setting", "menu:settings");

  return kb;
}