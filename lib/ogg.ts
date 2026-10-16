const MAX_U64 = 0xffffffffffffffffn;

/** مدت واقعی یک فایل OGG/Opus به ثانیه؛ اگر معتبر نبود null */
export function oggOpusDurationSec(buf: Buffer): number | null {
  if (buf.length < 64 || buf.toString("latin1", 0, 4) !== "OggS") return null;

  const head = buf.indexOf("OpusHead", 0, "latin1");
  if (head < 0 || head > 200 || head + 12 > buf.length) return null;
  const preSkip = buf.readUInt16LE(head + 10);

  // آخرین صفحه‌ی معتبر OGG را از انتها پیدا کن
  let pos = buf.length - 4;
  while (pos >= 0) {
    pos = buf.lastIndexOf("OggS", pos, "latin1");
    if (pos < 0 || pos + 14 > buf.length) return null;
    if (buf[pos + 4] === 0) {
      const granule = buf.readBigUInt64LE(pos + 6);
      if (granule === MAX_U64) return null;
      const samples = Number(granule) - preSkip;
      return samples > 0 ? samples / 48000 : null;
    }
    pos -= 1;
  }
  return null;
}