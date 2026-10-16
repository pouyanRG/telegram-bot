import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, count, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bans, users } from "@/lib/schema";
import { destroyAdminSession, isAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>;
}) {
  if (!(await isAdmin())) redirect("/admin/login");

  const q = ((await searchParams) ?? {}).q?.trim() ?? "";

  async function setBan(formData: FormData) {
    "use server";
    if (!(await isAdmin())) redirect("/admin/login");
    const id = Number(formData.get("id"));
    const ban = formData.get("ban") === "1";
    if (!Number.isSafeInteger(id)) return;

    const db = getDb();
    await db.update(users).set({ isBanned: ban }).where(eq(users.telegramId, id));
    if (ban) {
      await db.insert(bans).values({ userId: id, reason: "manual" });
    } else {
      await db
        .update(bans)
        .set({ unbannedAt: new Date() })
        .where(and(eq(bans.userId, id), isNull(bans.unbannedAt)));
    }
    revalidatePath("/admin");
  }

  async function logout() {
    "use server";
    await destroyAdminSession();
    redirect("/admin/login");
  }

  let stats: { total: number; active: number; banned: number } | null = null;
  let rows: (typeof users.$inferSelect)[] = [];

  try {
    const db = getDb();
    const [t] = await db.select({ v: count() }).from(users);
    const [a] = await db
      .select({ v: count() })
      .from(users)
      .where(gt(users.lastSeenAt, sql`now() - interval '24 hours'`));
    const [b] = await db.select({ v: count() }).from(users).where(eq(users.isBanned, true));
    stats = { total: t.v, active: a.v, banned: b.v };

    const asId = Number(q);
    rows = await db
      .select()
      .from(users)
      .where(
        q
          ? or(
              ilike(users.username, `%${q}%`),
              Number.isSafeInteger(asId) ? eq(users.telegramId, asId) : undefined
            )
          : undefined
      )
      .orderBy(desc(users.lastSeenAt))
      .limit(50);
  } catch (e) {
    console.error("Admin DB error:", e);
  }

  return (
    <main>
      <h1>پنل مدیریت</h1>
      <form action={logout}>
        <button type="submit">خروج</button>
      </form>

      {stats ? (
        <p>
          کل کاربران: {stats.total} | فعال ۲۴ ساعت اخیر: {stats.active} | مسدود: {stats.banned}
        </p>
      ) : (
        <p>دیتابیس متصل نیست</p>
      )}

      <form method="GET" action="/admin" style={{ margin: "16px 0" }}>
        <input name="q" defaultValue={q} placeholder="آیدی عددی یا یوزرنیم" />
        <button type="submit">جستجو</button>
      </form>

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th>آیدی</th>
            <th>یوزرنیم</th>
            <th>نام</th>
            <th>آخرین فعالیت</th>
            <th>وضعیت</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.telegramId}>
              <td>{u.telegramId}</td>
              <td>{u.username ? `@${u.username}` : "—"}</td>
              <td>{u.firstName ?? "—"}</td>
              <td>{u.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")}</td>
              <td>{u.isBanned ? "⛔️ مسدود" : "✅ فعال"}</td>
              <td>
                <form action={setBan}>
                  <input type="hidden" name="id" value={u.telegramId} />
                  <input type="hidden" name="ban" value={u.isBanned ? "0" : "1"} />
                  <button type="submit">{u.isBanned ? "رفع مسدودی" : "مسدود کن"}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
