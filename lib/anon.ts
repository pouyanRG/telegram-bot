import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { anonChats, anonMessages, anonState } from "./schema";

// «حداکثر تا ۲ دقیقه صبر کنید»
const WAIT_MINUTES = 2;
// حداقل مدت چت قبل از اینکه بشود قطعش کرد
export const MIN_CHAT_SEC = 10;

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const newCode = () =>
  Array.from(randomBytes(5), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

export type JoinResult =
  | { status: "chatting"; partnerId: number }
  | { status: "waiting" }
  | { status: "matched"; partnerId: number; chatId: number };

export async function joinQueue(me: number): Promise<JoinResult> {
  return getDb().transaction(async (tx) => {
    const [cur] = await tx.select().from(anonState).where(eq(anonState.userId, me));
    if (cur?.state === "chatting" && cur.partnerId) {
      return { status: "chatting", partnerId: cur.partnerId };
    }
    if (cur) await tx.delete(anonState).where(eq(anonState.userId, me)); // صف قدیمی

    const rows = (await tx.execute(sql`
      update anon_state a
         set state = 'chatting', partner_id = ${me}::bigint, updated_at = now()
       where a.user_id = (
         select user_id from anon_state
          where state = 'waiting'
            and user_id <> ${me}::bigint
            and updated_at > now() - make_interval(mins => ${WAIT_MINUTES}::int)
          order by updated_at
          limit 1
          for update skip locked
       )
      returning a.user_id
    `)) as unknown as { user_id: string | number }[];

    if (rows.length > 0) {
      const partnerId = Number(rows[0].user_id);

      let chatId: number | null = null;
      for (let i = 0; i < 5 && chatId === null; i++) {
        const [c] = await tx
          .insert(anonChats)
          .values({ code: newCode(), userA: partnerId, userB: me })
          .onConflictDoNothing()
          .returning({ id: anonChats.id });
        if (c) chatId = c.id;
      }
      if (chatId === null) throw new Error("could not allocate chat code");

      await tx.update(anonState).set({ chatId }).where(eq(anonState.userId, partnerId));
      await tx.insert(anonState).values({ userId: me, state: "chatting", partnerId, chatId });
      return { status: "matched", partnerId, chatId };
    }

    await tx.insert(anonState).values({ userId: me, state: "waiting" });
    return { status: "waiting" };
  });
}

export type LeaveResult =
  | { was: "none" }
  | { was: "waiting" }
  | { was: "chatting"; partnerId: number | null; chatId: number | null };

/** خروج از صف یا پایان چت؛ طرف مقابل هم آزاد می‌شود */
export async function leaveChat(me: number): Promise<LeaveResult> {
  return getDb().transaction(async (tx) => {
    const [cur] = await tx.delete(anonState).where(eq(anonState.userId, me)).returning();
    if (!cur) return { was: "none" };
    if (cur.state === "waiting") return { was: "waiting" };
    if (cur.partnerId) {
      await tx
        .delete(anonState)
        .where(and(eq(anonState.userId, cur.partnerId), eq(anonState.partnerId, me)));
    }
    if (cur.chatId) {
      await tx
        .update(anonChats)
        .set({ endedAt: new Date() })
        .where(and(eq(anonChats.id, cur.chatId), isNull(anonChats.endedAt)));
    }
    return { was: "chatting", partnerId: cur.partnerId, chatId: cur.chatId };
  });
}

/** فقط لغو جستجو (اگر وسط چت باشد کاری نمی‌کند). true یعنی واقعاً در صف بود */
export async function cancelSearch(me: number) {
  const rows = await getDb()
    .delete(anonState)
    .where(and(eq(anonState.userId, me), eq(anonState.state, "waiting")))
    .returning({ id: anonState.userId });
  return rows.length > 0;
}

export async function getAnon(me: number) {
  const [r] = await getDb().select().from(anonState).where(eq(anonState.userId, me));
  if (!r) return null;
  // بیشتر از ۲ دقیقه در صف مانده؛ دیگر در جستجو حساب نمی‌شود
  if (r.state === "waiting" && Date.now() - r.updatedAt.getTime() > WAIT_MINUTES * 60_000) {
    await getDb()
      .delete(anonState)
      .where(and(eq(anonState.userId, me), eq(anonState.state, "waiting")));
    return null;
  }
  return { state: r.state as "waiting" | "chatting", partnerId: r.partnerId, chatId: r.chatId };
}

// ---------- چت‌ها و پیام‌ها ----------

export async function getChat(id: number) {
  const [c] = await getDb().select().from(anonChats).where(eq(anonChats.id, id));
  return c ?? null;
}

export async function getChatByCode(code: string) {
  const [c] = await getDb().select().from(anonChats).where(eq(anonChats.code, code));
  return c ?? null;
}

export async function logMessages(
  chatId: number,
  items: { userId: number; messageId: number; fromId: number }[]
) {
  await getDb()
    .insert(anonMessages)
    .values(items.map((i) => ({ chatId, userId: i.userId, messageId: i.messageId, fromId: i.fromId })));
}

/** پیام‌های ۴۸ ساعت اخیر چت را از هر دو طرف حذف می‌کند؛ تعداد را برمی‌گرداند */
export async function deleteChatMessages(api: Api, chatId: number) {
  const db = getDb();
  const rows = await db
    .select()
    .from(anonMessages)
    .where(
      and(
        eq(anonMessages.chatId, chatId),
        gt(anonMessages.createdAt, new Date(Date.now() - 48 * 3600_000))
      )
    );

  const byUser = new Map<number, number[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push(r.messageId);
    byUser.set(r.userId, list);
  }
  for (const [uid, ids] of byUser) {
    for (let i = 0; i < ids.length; i += 100) {
      await api
        .deleteMessages(uid, ids.slice(i, i + 100))
        .catch((e) => console.error("deleteMessages error:", e instanceof Error ? e.message : "unknown"));
    }
  }
  await db.delete(anonMessages).where(eq(anonMessages.chatId, chatId));
  return rows.length;
}


/** آخرین چت بین دو کاربر */
export async function findLastChatBetween(a: number, b: number) {
  const [c] = await getDb()
    .select()
    .from(anonChats)
    .where(
      or(
        and(eq(anonChats.userA, a), eq(anonChats.userB, b)),
        and(eq(anonChats.userA, b), eq(anonChats.userB, a))
      )
    )
    .orderBy(desc(anonChats.id))
    .limit(1);
  return c ?? null;
}

/** ۱۵۰ پیام آخر چت از دید یک کاربر (هم پیام‌های خودش، هم پیام‌های دریافتی) */
export async function snapshotChat(chatId: number, viewerId: number) {
  const rows = await getDb()
    .select({ m: anonMessages.messageId, f: anonMessages.fromId })
    .from(anonMessages)
    .where(and(eq(anonMessages.chatId, chatId), eq(anonMessages.userId, viewerId)))
    .orderBy(desc(anonMessages.id))
    .limit(150);
  return rows.reverse();
}