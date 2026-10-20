const cooldown = new Map<string, number>();
const COOLDOWN_MS = 10 * 60 * 1000; // کلیدی که 429 داد، ۱۰ دقیقه کنار می‌ماند

export function geminiKeys(): string[] {
  const raw = process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** درخواست به Gemini؛ روی 429 سراغ کلید بعدی می‌رود */
export async function geminiFetch(
  model: string | undefined,
  body: unknown,
  timeoutMs: number
): Promise<Response> {
  const keys = geminiKeys();
  if (keys.length === 0 || !model) {
    throw new Error("GEMINI_API_KEYS and GEMINI_MODEL must be set");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const payload = JSON.stringify(body);
  const signal = AbortSignal.timeout(timeoutMs); // یک ددلاین برای کل تلاش‌ها

  const now = Date.now();
  const live = keys.filter((k) => (cooldown.get(k) ?? 0) <= now);
  const order = live.length ? live : keys; // اگر همه در cooldown بودند، همه را امتحان کن

  let last: Response | null = null;
  for (const key of order) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: payload,
      signal,
    });
    if (res.status !== 429) return res;
    cooldown.set(key, Date.now() + COOLDOWN_MS);
    console.warn(`gemini 429 on key …${key.slice(-4)}, trying next`);
    last = res;
  }
  return last!;
}
