import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { profileLikes, users } from "./schema";

export type LikeResult =
  | { status: "ok"; likes: number }
  | { status: "already"; likes: number }
  | { status: "self" }
  | { status: "missing" };

export async function likeProfile(likerId: number, targetId: number): Promise<LikeResult> {
  if (likerId === targetId) return { status: "self" };
  try {
    return await getDb().transaction(async (tx) => {
      const ins = await tx
        .insert(profileLikes)
        .values({ likerId, targetId })
        .onConflictDoNothing()
        .returning({ id: profileLikes.likerId });

      if (ins.length === 0) {
        const [u] = await tx
          .select({ likes: users.likesCount })
          .from(users)
          .where(eq(users.telegramId, targetId));
        return { status: "already", likes: u?.likes ?? 0 } as const;
      }
      const [u] = await tx
        .update(users)
        .set({ likesCount: sql`${users.likesCount} + 1` })
        .where(eq(users.telegramId, targetId))
        .returning({ likes: users.likesCount });
      if (!u) throw new Error("target missing");
      return { status: "ok", likes: u.likes } as const;
    });
  } catch {
    return { status: "missing" };
  }
}