import { eq } from "drizzle-orm";
import { InlineKeyboard, Keyboard } from "grammy";
import { getDb } from "./db";
import { cache, users } from "./schema";

export const AGE_MIN = 9;
export const AGE_MAX = 99;
export const BACK_TEXT = "بازگشت";

// ترتیب دقیقاً مثل اسکرین‌شات: هر ردیف ۳ تا، از چپ به راست
export const PROVINCES: readonly string[] = [
  "آذربایجان شرقی", "آذربایجان غربی", "اردبیل",
  "اصفهان", "البرز", "ایلام",
  "بوشهر", "تهران", "چهارمحال و بختیاری",
  "خراسان جنوبی", "خراسان رضوی", "خراسان شمالی",
  "خوزستان", "زنجان", "سمنان",
  "سیستان و بلوچستان", "فارس", "قزوین",
  "قم", "کردستان", "کرمان",
  "کرمانشاه", "کهگیلویه و بویراحمد", "گلستان",
  "گیلان", "لرستان", "مازندران",
  "مرکزی", "هرمزگان", "همدان",
  "یزد",
];

export type Gender = "m" | "f";
export type Step = "age" | "province";

// ---------- متن‌ها و کیبوردها (مطابق اسکرین‌شات‌ها) ----------

export const GENDER_TEXT = "❓ لطفا جنسیت خود را انتخاب کنید 👇";

export const AGE_TEXT = [
  "خب حالا سنت رو بهم بگو ؟",
  "",
  "<blockquote>• سنت رو از لیست پایین 👇 انتخاب کن یا خودت تایپ کن</blockquote>",
].join("\n");

export const PROVINCE_TEXT = "❓ لطفا استان خود را انتخاب کنید 👇";

// اینلاین زیر پیام؛ ترتیب از چپ به راست: پسرم | دخترم
export const genderKb = new InlineKeyboard()
  .text("من 👦 پسرم", "profile:gender:m")
  .text("من 🙍‍♀️ دخترم", "profile:gender:f");

// ۹ تا ۹۹، هر ردیف ۶ تا (۹..۱۴ / ۱۵..۲۰ / ...)
export function ageKb() {
  const kb = new Keyboard();
  for (let a = AGE_MIN; a <= AGE_MAX; a++) {
    kb.text(String(a));
    if ((a - AGE_MIN + 1) % 6 === 0 && a < AGE_MAX) kb.row();
  }
  return kb.resized();
}

// ردیف اول «بازگشت» تمام‌عرض، بعد استان‌ها ۳تا‌۳تا
export function provinceKb() {
  const kb = new Keyboard().text(BACK_TEXT).row();
  PROVINCES.forEach((p, i) => {
    kb.text(p);
    if ((i + 1) % 3 === 0 && i < PROVINCES.length - 1) kb.row();
  });
  return kb.resized();
}

// ---------- اعتبارسنجی ----------

const FA_DIGITS = /[۰-۹٠-٩]/g;
export function parseAge(raw: string): number | null {
  const s = raw
    .trim()
    .replace(FA_DIGITS, (d) => String(d.charCodeAt(0) & 0xf)); // فارسی/عربی → لاتین
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= AGE_MIN && n <= AGE_MAX ? n : null;
}

export const isProvince = (s: string) => PROVINCES.includes(s);

// ---------- پروفایل در دیتابیس ----------

export async function getProfile(userId: number) {
  const [u] = await getDb()
    .select({ gender: users.gender, age: users.age, province: users.province })
    .from(users)
    .where(eq(users.telegramId, userId));
  return u ?? null;
}

/** null یعنی پروفایل کامل است؛ در غیر این صورت اولین مرحله‌ی ناقص */
export function missingStep(
  p: { gender: string | null; age: number | null; province: string | null } | null
): "gender" | Step | null {
  if (!p?.gender) return "gender";
  if (p.age == null) return "age";
  if (!p.province) return "province";
  return null;
}

export const saveGender = (id: number, gender: Gender) =>
  getDb().update(users).set({ gender }).where(eq(users.telegramId, id));

export const saveAge = (id: number, age: number) =>
  getDb().update(users).set({ age }).where(eq(users.telegramId, id));

export const saveProvince = (id: number, province: string) =>
  getDb().update(users).set({ province }).where(eq(users.telegramId, id));

// ---------- مرحله‌ی فعلی (سرورلس است، پس در جدول cache) ----------

const stepKey = (id: number) => `profile_step:${id}`;

export async function setStep(userId: number, step: Step) {
  const data = { step };
  await getDb()
    .insert(cache)
    .values({ key: stepKey(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function getStep(userId: number): Promise<Step | null> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, stepKey(userId)));
  const s = (row?.data as { step?: string } | undefined)?.step;
  return s === "age" || s === "province" ? s : null;
}

export async function clearStep(userId: number) {
  await getDb().delete(cache).where(eq(cache.key, stepKey(userId)));
}