import { InlineKeyboard, Keyboard } from "grammy";

export function mainMenu(isAdmin = false) {
  const kb = new InlineKeyboard()
    .text("🧠 دستیار شخصی", "menu:assistant")
    .row()
    .text("🎭 شخصیت‌ها", "menu:persona")
    .text("🎙 ویس به متن", "menu:voice")
    .row();

  if (isAdmin) kb.text("📰 خبر شخصی", "menu:news");
  kb.text("💰 رمزارزها", "menu:prices").row().text("ℹ️ راهنما", "menu:help");

  if (isAdmin) kb.row().text("⚙️ Setting", "menu:settings");
  return kb;
}

// ---------- کیبورد ثابت پایین ----------

// اگر ربات اجازه‌ی آیکن سفارشی دارد، آیدی ایموجی را اینجا بگذار.
// خالی = ایموجی معمولی کنار متن دکمه
const ICON_IDS: Record<string, string> = {
  connect: "",
  nearby: "",
  search: "",
  help: "",
  profile: "",
  coins: "",
  link: "",
  feedback: "",
};

const DEFS = {
  connect: { emoji: "💬", text: "به یه ناشناس وصلم کن!" },
  nearby: { emoji: "📍", text: "افراد نزدیک من" },
  search: { emoji: "🔮", text: "جستجوی کاربران" },
  help: { emoji: "❓", text: "راهنما" },
  profile: { emoji: "👤", text: "پروفایل" },
  coins: { emoji: "💰", text: "سکه" },
  link: { emoji: "💌", text: "لینک ناشناس من" },
  feedback: { emoji: "📮", text: "انتقادات و پیشنهادات" },
} as const;

type Key = keyof typeof DEFS;

// اگر آیکن سفارشی باشد متن بدون ایموجی است، وگرنه ایموجی در متن می‌آید.
// (hears هم با همین مقدار کار می‌کند)
const label = (k: Key) => (ICON_IDS[k] ? DEFS[k].text : `${DEFS[k].emoji} ${DEFS[k].text}`);

export const BTN = {
  connect: label("connect"),
  nearby: label("nearby"),
  search: label("search"),
  help: label("help"),
  profile: label("profile"),
  coins: label("coins"),
  link: label("link"),
  feedback: label("feedback"),
  cancel: "❌ لغو جستجو",
  end: "🛑 پایان چت",
  next: "⏭ نفر بعدی",
  menu: "📋 منو",
  peer: "👀 پروفایل مخاطب",
  safe: "🔒 چت ایمن",
} as const;

type Btn = {
  text: string;
  style?: "primary" | "success" | "danger";
  icon_custom_emoji_id?: string;
};

const b = (k: Key, style?: Btn["style"]): Btn => ({
  text: BTN[k],
  ...(style ? { style } : {}),
  ...(ICON_IDS[k] ? { icon_custom_emoji_id: ICON_IDS[k] } : {}),
});

// ترتیب هر ردیف از چپ به راست است (چیدمان تلگرام)
export const idleKb = {
  keyboard: [
    [b("connect", "success")],
    [b("search"), b("nearby")],
    [b("coins"), b("profile"), b("help")],
    [b("link"), b("feedback")],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const waitingKb = new Keyboard().text(BTN.cancel).resized().persistent();

export const chatKb = new Keyboard()
  .text(BTN.peer).text(BTN.safe).row()
  .text(BTN.end).text(BTN.next)
  .resized().persistent();