import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { cache } from "./schema";

export type G = "m" | "f";
const photoKey = (g: G) => `default_photo:${g}`;
const pendingKey = (id: number) => `pending_defphoto:${id}`;

export async function getDefaultPhoto(gender: string | null): Promise<string | null> {
  if (gender !== "m" && gender !== "f") return null;
  const [row] = await getDb().select().from(cache).where(eq(cache.key, photoKey(gender)));
  return (row?.data as { fileId?: string } | undefined)?.fileId ?? null;
}

export async function setDefaultPhoto(g: G, fileId: string) {
  const data = { fileId };
  await getDb()
    .insert(cache)
    .values({ key: photoKey(g), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function setPendingDefPhoto(userId: number, g: G) {
  const data = { g };
  await getDb()
    .insert(cache)
    .values({ key: pendingKey(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

/** اگر در انتظار عکس بود، جنسیت را برمی‌گرداند و حالت را پاک می‌کند */
export async function takePendingDefPhoto(userId: number): Promise<G | null> {
  const rows = await getDb()
    .delete(cache)
    .where(eq(cache.key, pendingKey(userId)))
    .returning({ data: cache.data });
  const g = (rows[0]?.data as { g?: string } | undefined)?.g;
  return g === "m" || g === "f" ? g : null;
}