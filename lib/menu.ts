const DEFS = {
  help: { emoji: "❓", text: "راهنما" },
  feedback: { emoji: "📮", text: "انتقادات و پیشنهادات" },
  prices: { emoji: "💰", text: "رمزارزها" },
  voice: { emoji: "🎙", text: "ویس به متن" },
  news: { emoji: "📰", text: "اخبار روز" },
  mediaStickers: { emoji: "🎨", text: "استیکر و گیف" },
  mediaVideoNote: { emoji: "📽️", text: "ویدیو مسیج" },
  settings: { emoji: "⚙️", text: "تنظیمات" },
  menu: { emoji: "🏠", text: "منوی اصلی" },
} as const;

type Key = keyof typeof DEFS;

const label = (key: Key) => `${DEFS[key].emoji} ${DEFS[key].text}`;

export const BTN = {
  help: label("help"),
  feedback: label("feedback"),
  prices: label("prices"),
  voice: label("voice"),
  news: label("news"),
  mediaStickers: label("mediaStickers"),
  mediaVideoNote: label("mediaVideoNote"),
  settings: label("settings"),
  menu: label("menu"),
} as const;

export function mainMenu(isAdmin = false) {
  const keyboard = [
    [BTN.voice],
    [BTN.news,BTN.prices,],
    [BTN.mediaVideoNote, BTN.mediaStickers],
    [BTN.feedback, BTN.help],
  ];
  if (isAdmin) keyboard.push([BTN.settings]);

  return {
    keyboard,
    resize_keyboard: true,
    input_field_placeholder: "menu",
  };
}
