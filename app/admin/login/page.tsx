import { redirect } from "next/navigation";
import {
  clearLoginFailures,
  createAdminSession,
  getLoginLock,
  isAdmin,
  passwordMatches,
  recordLoginFailure,
} from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  if (await isAdmin()) redirect("/admin");
  const params = (await searchParams) ?? {};
  const lock = await getLoginLock();

  async function login(formData: FormData) {
    "use server";
    if ((await getLoginLock()).locked) redirect("/admin/login");

    const password = String(formData.get("password") ?? "");
    if (!passwordMatches(password)) {
      await recordLoginFailure();
      await new Promise((r) => setTimeout(r, 800));
      redirect("/admin/login?error=1");
    }

    await clearLoginFailures();
    await createAdminSession();
    redirect("/admin");
  }

  return (
    <main style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>ورود به پنل مدیریت</h1>

      {lock.locked ? (
        <p style={{ color: "crimson" }}>
          تلاش‌های ناموفق زیاد بود. حدود {lock.retryAfterMin} دقیقه دیگر دوباره امتحان کن.
        </p>
      ) : (
        params.error && <p style={{ color: "crimson" }}>رمز عبور اشتباه است.</p>
      )}




      <form action={login} style={{ display: "grid", gap: 12 }}>
        <input
          name="password"
          type="password"
          required
          disabled={lock.locked}
          autoComplete="current-password"
          placeholder="رمز عبور"
          style={{ padding: 10 }}
        />
        <button
          type="submit"
          disabled={lock.locked}
          style={{ padding: "10px 16px", cursor: lock.locked ? "not-allowed" : "pointer" }}
        >
          ورود
        </button>
      </form>
    </main>
  );
}