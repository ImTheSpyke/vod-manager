import { ChildProcess, execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

export interface DownloadCallbacks {
  onProgress: (info: { percent: number; speed: string | null; eta: string | null }) => void;
  onLog: (line: string) => void;
  onAttempt: (attempt: number, maxAttempts: number) => void;
  onInfo?: (info: {
    title: string | null;
    channel: string | null;
    channelUrl: string | null;
    uploadDate: string | null;
    durationSeconds: number | null;
    durationLabel: string | null;
  }) => void;
}

export interface DownloadResult {
  outputFile: string;
  title: string | null;
  channel: string | null;
  channelUrl: string | null;
  uploadDate: string | null;
  durationSeconds: number | null;
  durationLabel: string | null;
}

export type DownloadAbortReason = "pause" | "cancel";

export class DownloadAbortError extends Error {
  constructor(public readonly reason: DownloadAbortReason) {
    super(reason === "pause" ? "Download paused" : "Download canceled");
    this.name = "DownloadAbortError";
  }
}

/** Abort handle that carries a pause vs cancel reason (ES2020-safe). */
export class DownloadController {
  private readonly ac = new AbortController();
  private _reason: DownloadAbortReason = "cancel";

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  get aborted(): boolean {
    return this.ac.signal.aborted;
  }

  get reason(): DownloadAbortReason {
    return this._reason;
  }

  abort(reason: DownloadAbortReason): void {
    if (this.ac.signal.aborted) return;
    this._reason = reason;
    this.ac.abort();
  }
}

export const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(__dirname, "..", "..", "downloads");
const MAX_ATTEMPTS = parseInt(process.env.MAX_DOWNLOAD_ATTEMPTS || "8", 10);
// Backoff (seconds) for generic failures, attempt-indexed (0-based), capped at last value.
const BACKOFF_SECONDS = [10, 30, 60, 120, 300, 300, 300, 300];
// Longer, distinct backoff for rate-limiting (HTTP 429) — Twitch/Cloudfront throttling.
const RATE_LIMIT_BACKOFF_SECONDS = 600;

function throwIfAborted(controller?: DownloadController): void {
  if (controller?.aborted) {
    throw new DownloadAbortError(controller.reason);
  }
}

function sleep(ms: number, controller?: DownloadController): Promise<void> {
  return new Promise((resolve, reject) => {
    if (controller?.aborted) {
      reject(new DownloadAbortError(controller.reason));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DownloadAbortError(controller!.reason));
    };
    controller?.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRateLimited(logChunk: string): boolean {
  return /HTTP Error 429|Too Many Requests|429:/i.test(logChunk);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatVodDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.replace(/-/g, "");
  const match = compact.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseEtaToSeconds(eta: string): number | null {
  const parts = eta.split(":").map((p) => parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function formatEta(seconds: number): string {
  let s = Math.max(0, Math.round(seconds));
  // Quantize so the UI doesn't flicker by 1–2 seconds every update.
  if (s >= 90) s = Math.round(s / 15) * 15;
  else if (s >= 20) s = Math.round(s / 5) * 5;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Smooths yt-dlp's jumpy fragment ETA by blending it with elapsed/percent
 * inference and resisting small upward bounces.
 */
class EtaSmoother {
  private etaSec: number | null = null;
  private lastTick = Date.now();
  private startedAt = Date.now();
  private lastPercent = 0;
  private lastShown = "";

  update(
    percent: number,
    etaRaw: string | null,
    speed: string | null
  ): { percent: number; speed: string | null; eta: string | null } {
    const now = Date.now();
    if (percent + 12 < this.lastPercent) {
      this.etaSec = null;
      this.startedAt = now;
      this.lastShown = "";
    }
    this.lastPercent = percent;

    const parsed = etaRaw ? parseEtaToSeconds(etaRaw) : null;
    let inferred: number | null = null;
    if (percent > 2 && percent < 99.5) {
      const elapsed = (now - this.startedAt) / 1000;
      inferred = elapsed * ((100 - percent) / percent);
    }

    let reported: number | null = null;
    if (parsed != null && inferred != null) {
      reported = inferred * 0.7 + parsed * 0.3;
    } else {
      reported = parsed ?? inferred;
    }

    const dt = Math.min(5, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;

    if (reported == null) {
      if (this.etaSec != null) this.etaSec = Math.max(0, this.etaSec - dt);
    } else if (this.etaSec == null) {
      this.etaSec = reported;
    } else {
      const ticked = Math.max(0, this.etaSec - dt);
      if (reported <= ticked + 3) {
        this.etaSec = ticked * 0.78 + Math.min(reported, ticked) * 0.22;
      } else {
        this.etaSec = ticked * 0.97 + reported * 0.03;
      }
    }

    if (this.etaSec == null || percent >= 100) {
      return { percent, speed, eta: percent >= 100 ? "0:00" : etaRaw };
    }

    let eta = formatEta(this.etaSec);
    const prev = this.lastShown ? parseEtaToSeconds(this.lastShown) : null;
    const next = parseEtaToSeconds(eta);
    if (prev != null && next != null && next > prev && next - prev < 8) {
      eta = this.lastShown;
    }
    this.lastShown = eta;
    return { percent, speed, eta };
  }
}

function parseProgressLine(
  line: string,
  fragmentState: { total: number | null }
): { percent: number; speed: string | null; eta: string | null } | null {
  const fragTotal = line.match(/Total fragments:\s*(\d+)/i);
  if (fragTotal) {
    fragmentState.total = parseInt(fragTotal[1], 10);
  }

  const frag = line.match(/Downloading fragment\s+(\d+)\s*(?:\/|of)\s*(\d+)/i);
  if (frag) {
    const current = parseInt(frag[1], 10);
    const total = parseInt(frag[2], 10);
    fragmentState.total = total;
    if (total > 0) {
      const percent = Math.min(100, (current / total) * 100);
      return { percent, speed: null, eta: null };
    }
  }

  const match = line.match(
    /\[download\]\s+(\d{1,3}(?:\.\d+)?)%\s+of\s+~?\s*\S+(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/i
  );
  if (!match) return null;
  const percent = parseFloat(match[1]);
  if (Number.isNaN(percent)) return null;
  const speed = match[2] && match[2] !== "Unknown" ? match[2] : null;
  const eta = match[3] && match[3] !== "Unknown" ? match[3] : null;
  return { percent, speed, eta };
}

function parseDateFromFilename(filePath: string): string | null {
  const base = path.basename(filePath);
  const match = base.match(/^(\d{8})\b/);
  return formatVodDate(match ? match[1] : null);
}

export function extractVodId(url: string): string | null {
  const match = url.match(/twitch\.tv\/(?:videos\/(\d+)|\w+\/(?:video|v)\/(\d+))/i);
  if (!match) return null;
  return match[1] || match[2] || null;
}

function isPartialDownloadFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower.includes(".part") ||
    lower.endsWith(".ytdl") ||
    lower.includes(".temp.") ||
    /\.f\d+\./i.test(filename)
  );
}

export function probeDurationSeconds(filePath: string): number | null {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { encoding: "utf8", timeout: 20000 }
    );
    const n = parseFloat(String(out).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** True if the path is a real file inside the downloads directory. */
export function resolveManagedFile(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const root = path.resolve(DOWNLOAD_DIR);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

export function findCompletedFile(url: string): string | null {
  const id = extractVodId(url);
  if (!id || !fs.existsSync(DOWNLOAD_DIR)) return null;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(DOWNLOAD_DIR);
  } catch {
    return null;
  }
  const match = entries.find((name) => {
    if (!name.includes(id) || isPartialDownloadFile(name)) return false;
    return /\.(mp4|mkv|webm)$/i.test(name);
  });
  return match ? path.join(DOWNLOAD_DIR, match) : null;
}

/** Remove yt-dlp temp/partial files for a VOD so a canceled job does not leave junk. */
export function cleanupPartialDownloads(url: string): void {
  const id = extractVodId(url);
  if (!id || !fs.existsSync(DOWNLOAD_DIR)) return;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(DOWNLOAD_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.includes(id) || !isPartialDownloadFile(name)) continue;
    try {
      fs.unlinkSync(path.join(DOWNLOAD_DIR, name));
    } catch {
      // Best-effort; a locked fragment should not fail cancel.
    }
  }
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 2000);
}

function cleanMetaField(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "NA" || trimmed === "None") return null;
  return trimmed;
}

function pickChannel(...candidates: Array<string | null | undefined>): string | null {
  for (const value of candidates) {
    const cleaned = cleanMetaField(value || undefined);
    // Skip bare video ids like v2486248624
    if (cleaned && !/^v?\d+$/i.test(cleaned)) return cleaned;
  }
  return null;
}

function pickChannelUrl(
  channelUrl?: string,
  uploaderUrl?: string,
  uploaderId?: string
): string | null {
  for (const value of [channelUrl, uploaderUrl]) {
    const cleaned = cleanMetaField(value);
    if (cleaned && /^https?:\/\//i.test(cleaned)) return cleaned.replace(/\/+$/, "");
  }
  const id = cleanMetaField(uploaderId);
  if (id && !/^v?\d+$/i.test(id)) return `https://www.twitch.tv/${id}`;
  return null;
}

function parseMetaLine(line: string): {
  uploadDate: string | null;
  durationSeconds: number | null;
  durationLabel: string | null;
  channel: string | null;
  channelUrl: string | null;
  title: string | null;
} | null {
  const raw = line.startsWith("META:") ? line.slice(5) : "";
  if (!raw) return null;
  const [
    dateRaw,
    durSecRaw,
    durStrRaw,
    uploaderRaw,
    channelRaw,
    uploaderIdRaw,
    channelUrlRaw,
    uploaderUrlRaw,
    ...titleParts
  ] = raw.split("|");
  const uploadDate = formatVodDate(dateRaw && dateRaw !== "NA" ? dateRaw : null);
  const durationSeconds =
    durSecRaw && durSecRaw !== "NA" && Number.isFinite(parseFloat(durSecRaw))
      ? parseFloat(durSecRaw)
      : null;
  const durationLabel =
    cleanMetaField(durStrRaw) ||
    (durationSeconds != null ? formatDuration(durationSeconds) : null);
  const channel = pickChannel(uploaderRaw, channelRaw);
  const channelUrl = pickChannelUrl(channelUrlRaw, uploaderUrlRaw, uploaderIdRaw);
  const title = cleanMetaField(titleParts.join("|"));
  return { uploadDate, durationSeconds, durationLabel, channel, channelUrl, title };
}

/**
 * Runs a single yt-dlp attempt. Resolves with the final media file path on success.
 * Rejects with an Error (message includes raw output) on failure.
 */
function runYtDlpOnce(
  url: string,
  callbacks: DownloadCallbacks,
  controller: DownloadController | undefined,
  smoother: EtaSmoother
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    throwIfAborted(controller);

    const args = [
      url,
      "-f",
      "bestvideo*+bestaudio/best",
      "--merge-output-format",
      "mp4",
      "--restrict-filenames",
      "--no-playlist",
      "--newline",
      "--no-color",
      "--progress",
      "--continue",
      "--concurrent-fragments",
      "4",
      "--retries",
      "20",
      "--fragment-retries",
      "20",
      "--retry-sleep",
      "linear=5:30:5",
      "--print",
      "META:%(upload_date)s|%(duration)s|%(duration_string)s|%(uploader)s|%(channel)s|%(uploader_id)s|%(channel_url)s|%(uploader_url)s|%(title)s",
      "--print",
      "after_move:FILE:%(filepath)s",
      "-o",
      path.join(DOWNLOAD_DIR, "%(upload_date)s - %(id)s - %(title)s.%(ext)s"),
    ];

    const proc = spawn("yt-dlp", args, { cwd: DOWNLOAD_DIR });

    let finalPath: string | null = null;
    let meta: ReturnType<typeof parseMetaLine> = null;
    let stderrBuffer = "";
    let stdoutBuffer = "";
    let settled = false;
    const fragmentState = { total: null as number | null };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const handleOutput = (text: string, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdoutBuffer += text;
      else stderrBuffer += text;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("FILE:")) {
          finalPath = line.slice(5);
          continue;
        }
        if (line.startsWith("META:")) {
          meta = parseMetaLine(line);
          if (meta) callbacks.onInfo?.(meta);
          continue;
        }
        callbacks.onLog(line);
        const progress = parseProgressLine(line, fragmentState);
        if (progress) {
          callbacks.onProgress(smoother.update(progress.percent, progress.eta, progress.speed));
        }
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => handleOutput(chunk.toString(), "stdout"));
    proc.stderr.on("data", (chunk: Buffer) => handleOutput(chunk.toString(), "stderr"));

    proc.on("error", (err) => {
      settle(() => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
    });

    proc.on("close", (code) => {
      if (controller?.aborted) {
        settle(() => reject(new DownloadAbortError(controller.reason)));
        return;
      }
      if (code === 0) {
        const outputFile = (finalPath && fs.existsSync(finalPath) ? finalPath : "") || "";
        let durationSeconds = meta?.durationSeconds ?? null;
        let durationLabel = meta?.durationLabel ?? null;
        if (outputFile && durationSeconds == null) {
          durationSeconds = probeDurationSeconds(outputFile);
          if (durationSeconds != null) durationLabel = formatDuration(durationSeconds);
        }
        const title = meta?.title || null;
        const channel = meta?.channel || null;
        const channelUrl = meta?.channelUrl || null;
        const uploadDate = meta?.uploadDate || (outputFile ? parseDateFromFilename(outputFile) : null);
        settle(() =>
          resolve({
            outputFile,
            title,
            channel,
            channelUrl,
            uploadDate,
            durationSeconds,
            durationLabel,
          })
        );
        return;
      }
      const combined = stderrBuffer + "\n" + stdoutBuffer;
      const err = new Error(
        `yt-dlp exited with code ${code}: ${stderrBuffer.trim().slice(-800) || "unknown error"}`
      );
      (err as any).rateLimited = isRateLimited(combined);
      settle(() => reject(err));
    });

    const onAbort = () => {
      killProcessTree(proc);
    };
    if (controller?.aborted) {
      onAbort();
    } else {
      controller?.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Downloads a VOD with an outer retry loop on top of yt-dlp's own internal
 * retry/backoff, so we recover from full-process failures (network drop,
 * transient Twitch errors, 429 rate limiting) as well as fragment-level ones.
 *
 * yt-dlp `--continue` keeps fragment `.part` files, so a retry or process
 * restart resumes instead of starting from scratch.
 */
export async function downloadVod(
  url: string,
  callbacks: DownloadCallbacks,
  controller?: DownloadController
): Promise<DownloadResult> {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  let attempt = 0;
  let lastError: Error | null = null;
  const smoother = new EtaSmoother();

  while (attempt < MAX_ATTEMPTS) {
    throwIfAborted(controller);
    attempt += 1;
    callbacks.onAttempt(attempt, MAX_ATTEMPTS);
    try {
      const result = await runYtDlpOnce(url, callbacks, controller, smoother);
      return result;
    } catch (err: any) {
      if (err instanceof DownloadAbortError) throw err;
      lastError = err;
      const rateLimited = !!err.rateLimited;
      callbacks.onLog(
        rateLimited
          ? `Rate limited (HTTP 429). Waiting ${RATE_LIMIT_BACKOFF_SECONDS}s before retrying...`
          : `Attempt ${attempt} failed: ${err.message}`
      );

      if (attempt >= MAX_ATTEMPTS) break;

      const waitSeconds = rateLimited
        ? RATE_LIMIT_BACKOFF_SECONDS
        : BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
      if (rateLimited && attempt >= MAX_ATTEMPTS - 1) {
        attempt = Math.max(0, attempt - 1);
      }
      await sleep(waitSeconds * 1000, controller);
    }
  }

  throw lastError || new Error("Download failed for an unknown reason");
}
