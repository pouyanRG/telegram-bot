import type { Api } from "grammy";
import { UserError } from "./errors";

export async function downloadTelegramFile(api: Api, fileId: string, maxBytes: number) {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("telegram: no file_path");
  if ((file.file_size ?? Infinity) > maxBytes) {
    throw new UserError("📦 حجم این ویس بیش از حد مجاز است.");
  }

  // این URL شامل توکن ربات است: هرگز لاگ نشود
  const res = await fetch(
    `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok || !res.body) throw new Error(`telegram download failed (${res.status})`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new UserError("📦 حجم این ویس بیش از حد مجاز است.");

  // خواندن stream با سقف حجم (به content-length اعتماد نمی‌کنیم)
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UserError("📦 حجم این ویس بیش از حد مجاز است.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}