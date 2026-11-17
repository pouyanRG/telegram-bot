import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { cache } from "./schema";

// وضعیت «ویس به متن فعال است» برای هر کاربر (چون سرورلس است، در دیتابیس نگهداری می‌شود)
const modeKey = (userId: number) => `mode:${userId}`;

export async function setVoiceMode(userId: number) {
  await setMode(userId, "voice");
}

export async function setMediaMode(userId: number, mode: "media_stickers" | "media_video_note") {
  await setMode(userId, mode);
}

async function setMode(userId: number, mode: string) {
  const data = { mode };
  await getDb()
    .insert(cache)
    .values({ key: modeKey(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function clearMode(userId: number) {
  await getDb().delete(cache).where(eq(cache.key, modeKey(userId)));
}

export async function isVoiceMode(userId: number) {
  return (await getMode(userId)) === "voice";
}

export async function getMode(userId: number) {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, modeKey(userId)));
  return (row?.data as { mode?: string } | undefined)?.mode;
}
