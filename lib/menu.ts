import { InlineKeyboard, Keyboard } from "grammy";

export function mainMenu(isAdmin = false) {
  const kb = new InlineKeyboard()
    .text("🧠 دستیار شخصی", "menu:assistant")
    .row()
    .text("🎭 شخصیت‌ها", "menu:persona")
    .text("🎙 ویس به متن", "menu:voice")
    .row();

  // خبر فقط برای ادمین‌ها
  if (isAdmin) kb.text("📰 خبر شخصی", "menu:news");
  kb.text("💰 رمزارزها", "menu:prices").row().text("ℹ️ راهنما", "menu:help");

  if (isAdmin) kb.row().text("⚙️ Setting", "menu:settings");
  return kb;
}

// ---------- کیبورد ثابت پایین (چت ناشناس) ----------

export const BTN = {
  connect: "🎭 به یه ناشناس وصلم کن!",
  cancel: "❌ لغو جستجو",
  end: "🛑 پایان چت",
  next: "⏭ نفر بعدی",
  menu: "📋 منو",
  help: "🤔 راهنما",
} as const;

export const idleKb = new Keyboard()
  .text(BTN.connect)
  .row()
  .text(BTN.menu)
  .text(BTN.help)
  .resized()
  .persistent();

export const waitingKb = new Keyboard().text(BTN.cancel).resized().persistent();

export const chatKb = new Keyboard().text(BTN.end).text(BTN.next).resized().persistent();