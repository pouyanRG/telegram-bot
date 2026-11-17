import { InlineKeyboard } from "grammy";

export function mainMenu(isAdmin = false) {
  const kb = new InlineKeyboard()
    .text("🎙 ویس به متن", "menu:voice")
    .row()
    .text("💰 رمزارزها", "menu:prices")
    .row()
    .text("📰 اخبار روز", "menu:news")
    .row()
    .text("🎨 استیکر و گیف", "menu:media:stickers")
    .row()
    .text("📽️ ویدیو مسیج", "menu:media:video_note")
    .row()
    .text("راهنما", "menu:help");

  if (isAdmin) kb.row().text("⚙️ تنظیمات", "menu:settings");
  return kb;
}

// ---------- کیبورد ثابت پایین ----------

// اگر ربات اجازه‌ی آیکن سفارشی دارد، آیدی ایموجی را اینجا بگذار.
// خالی = ایموجی معمولی کنار متن دکمه
const ICON_IDS: Record<string, string> = {
  help: "",
  coins: "",
  feedback: "",
};

const DEFS = {
  help: { emoji: "❓", text: "راهنما" },
  coins: { emoji: "💰", text: "سکه" },
  feedback: { emoji: "📮", text: "انتقادات و پیشنهادات" },
} as const;

type Key = keyof typeof DEFS;

// اگر آیکن سفارشی باشد متن بدون ایموجی است، وگرنه ایموجی در متن می‌آید.
// (hears هم با همین مقدار کار می‌کند)
const label = (k: Key) => (ICON_IDS[k] ? DEFS[k].text : `${DEFS[k].emoji} ${DEFS[k].text}`);

export const BTN = {
  help: label("help"),
  coins: label("coins"),
  feedback: label("feedback"),
  menu: "📋 منو",
} as const;

type Btn = {
  text: string;
  icon_custom_emoji_id?: string;
};

const b = (k: Key): Btn => ({
  text: BTN[k],
  ...(ICON_IDS[k] ? { icon_custom_emoji_id: ICON_IDS[k] } : {}),
});

// ترتیب هر ردیف از چپ به راست است (چیدمان تلگرام)
export const idleKb = {
  keyboard: [[b("coins"), b("help")], [b("feedback")]],
  resize_keyboard: true,
  is_persistent: true,
};
