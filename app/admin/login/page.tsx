import { redirect } from "next/navigation";
import {
  createAdminSession,
  isAdmin,
  passwordMatches,
} from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  if (await isAdmin()) redirect("/admin");
  const params = (await searchParams) ?? {};

  async function login(formData: FormData) {
    "use server";
    const password = String(formData.get("password") ?? "");
    if (!passwordMatches(password)) {
      await new Promise((r) => setTimeout(r, 800));
      redirect("/admin/login?error=1");
    }
    await createAdminSession();
    redirect("/admin");
  }

  return (
    <main style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>ورود به پنل مدیریت</h1>
      {params.error && <p style={{ color: "crimson" }}>رمز عبور اشتباه است.</p>}
      <form action={login} style={{ display: "grid", gap: 12 }}>
        <input
          name="password"
          type="password"
          required
          placeholder="رمز عبور"
          style={{ padding: 10 }}
        />
        <button type="submit" style={{ padding: "10px 16px", cursor: "pointer" }}>
          ورود
        </button>
      </form>
    </main>
  );
}
