import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import ffmpegPath from "ffmpeg-static";

export type ConversionKind =
  | "video-note"
  | "video-animation"
  | "video-sticker"
  | "photo-sticker"
  | "photo-animation"
  | "sticker-image"
  | "sticker-animation";

export const MAX_STICKER_BYTES = 256_000;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 240_000;

function ffmpegBinary() {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available on this platform");
  return ffmpegPath;
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg conversion timed out"));
    }, FFMPEG_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8").slice(0, 4000 - stderr.length);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg conversion failed (${code}): ${stderr.slice(-1000)}`));
    });
  });
}

async function fileSize(path: string) {
  return (await stat(path)).size;
}

function videoNoteArgs(inputPath: string, outputPath: string, durationLimit = 60) {
  return [
    "-i", inputPath,
    "-t", String(durationLimit),
    "-vf", "scale=640:640:force_original_aspect_ratio=increase,crop=640:640,setsar=1,fps=30",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-threads", "1",
    "-f", "mp4",
    outputPath,
  ];
}

async function createPhotoSticker(inputPath: string, outputPath: string) {
  for (const quality of [78, 65, 52, 40, 28, 18]) {
    await runFfmpeg([
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
      "-an",
      "-c:v", "libwebp",
      "-q:v", String(quality),
      "-compression_level", "6",
      "-f", "webp",
      outputPath,
    ]);
    if (await fileSize(outputPath) <= MAX_STICKER_BYTES) return;
  }
  throw new Error("Could not encode a static sticker below Telegram's 256 KB limit");
}

async function createVideoSticker(inputPath: string, outputPath: string) {
  for (const bitrate of [550, 450, 350, 250, 150]) {
    await runFfmpeg([
      "-i", inputPath,
      "-t", "3",
      "-vf", "fps=30,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-an",
      "-c:v", "libvpx-vp9",
      "-b:v", `${bitrate}k`,
      "-maxrate", `${bitrate}k`,
      "-bufsize", `${bitrate * 2}k`,
      "-deadline", "good",
      "-cpu-used", "5",
      "-row-mt", "1",
      "-pix_fmt", "yuv420p",
      "-threads", "1",
      "-f", "webm",
      outputPath,
    ]);
    if (await fileSize(outputPath) <= MAX_STICKER_BYTES) return;
  }
  throw new Error("Could not encode a video sticker below Telegram's 256 KB limit");
}

export async function convertMedia(
  inputPath: string,
  outputPath: string,
  kind: ConversionKind
) {
  if (kind === "photo-sticker") {
    await createPhotoSticker(inputPath, outputPath);
  } else if (kind === "photo-animation") {
    await runFfmpeg([
      "-loop", "1",
      "-i", inputPath,
      "-t", "3",
      "-vf", "fps=15,scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "24",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-threads", "1",
      "-f", "mp4",
      outputPath,
    ]);
  } else if (kind === "video-sticker") {
    await createVideoSticker(inputPath, outputPath);
  } else if (kind === "sticker-image") {
    await runFfmpeg([
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale=1024:1024:force_original_aspect_ratio=decrease",
      "-an",
      "-c:v", "png",
      outputPath,
    ]);
  } else if (kind === "video-note") {
    await runFfmpeg(videoNoteArgs(inputPath, outputPath));
  } else if (kind === "sticker-animation") {
    await runFfmpeg([
      "-i", inputPath,
      "-t", "3",
      "-vf", "fps=30,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-threads", "1",
      "-f", "mp4",
      outputPath,
    ]);
  } else {
    await runFfmpeg([
      "-i", inputPath,
      "-t", "60",
      "-vf", "fps=15,scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "24",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-threads", "1",
      "-f", "mp4",
      outputPath,
    ]);
  }

  const size = await fileSize(outputPath);
  if (size > MAX_OUTPUT_BYTES) throw new Error("Converted file exceeds the 10 MB output limit");
  return size;
}

export function conversionExtension(kind: ConversionKind) {
  switch (kind) {
    case "video-sticker": return ".webm";
    case "photo-sticker": return ".webp";
    case "sticker-image": return ".png";
    default: return ".mp4";
  }
}
