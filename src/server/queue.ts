import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { DownloadJob, YoutubeStatus } from "./types";
import {
  cleanupPartialDownloads,
  downloadVod,
  DownloadAbortError,
  DownloadController,
  findCompletedFile,
  formatDuration,
  resolveManagedFile,
} from "./downloader";
import { sendNtfyNotification } from "./notify";
import {
  isYoutubeConfigured,
  uploadToYoutube,
  buildYoutubeTitle,
  buildYoutubeDescription,
  YoutubeUploadMeta,
  parseYoutubePrivacy,
  resolvePlaylistId,
} from "./youtube";
import { getYoutubeSettings } from "./settings";
import { invalidateStorageCache, isStorageFull } from "./storage";

const JOBS_PATH = process.env.JOBS_PATH || path.join(__dirname, "..", "..", "data", "jobs.json");
const MAX_LOG_LINES = 200;

function defaultYoutubeStatus(): YoutubeStatus {
  return "idle";
}

function normalizeJob(raw: Partial<DownloadJob> & { id: string; url: string }): DownloadJob {
  return {
    id: raw.id,
    url: raw.url,
    title: raw.title ?? null,
    status: raw.status || "queued",
    progressPercent: raw.progressPercent ?? 0,
    speed: raw.speed ?? null,
    eta: raw.eta ?? null,
    attempt: raw.attempt ?? 0,
    maxAttempts: raw.maxAttempts ?? parseInt(process.env.MAX_DOWNLOAD_ATTEMPTS || "8", 10),
    lastError: raw.lastError ?? null,
    outputFile: raw.outputFile ?? null,
    createdAt: raw.createdAt || new Date().toISOString(),
    startedAt: raw.startedAt ?? null,
    completedAt: raw.completedAt ?? null,
    log: Array.isArray(raw.log) ? raw.log : [],
    channel: raw.channel ?? null,
    channelUrl: raw.channelUrl ?? null,
    vodDate: raw.vodDate ?? null,
    vodDuration: raw.vodDuration ?? null,
    vodDurationSeconds: raw.vodDurationSeconds ?? null,
    fileDeleted: !!raw.fileDeleted,
    youtubeStatus: raw.youtubeStatus || defaultYoutubeStatus(),
    youtubeVideoId: raw.youtubeVideoId ?? null,
    youtubeProgress: raw.youtubeProgress ?? 0,
    youtubeError: raw.youtubeError ?? null,
  };
}

class DownloadQueue extends EventEmitter {
  private jobs: DownloadJob[] = [];
  private processing = false;
  private abortController: DownloadController | null = null;
  private currentJobId: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private youtubeUploading = new Set<string>();

  constructor() {
    super();
    this.load();
    let recovered = 0;
    for (const job of this.jobs) {
      if (job.status === "downloading" || job.status === "retrying") {
        job.status = "queued";
        this.appendLog(job, "Recovered after restart — continuing automatically.");
        recovered += 1;
      }
      if (job.youtubeStatus === "uploading") {
        job.youtubeStatus = "failed";
        job.youtubeError = "Upload interrupted by restart.";
        this.appendLog(job, "YouTube upload was interrupted by restart.");
      }
      if (job.status === "completed" && job.outputFile && !job.fileDeleted) {
        if (!resolveManagedFile(job.outputFile) && !findCompletedFile(job.url)) {
          job.fileDeleted = true;
        }
      }
    }
    this.persist();
    if (recovered > 0) {
      console.log(`Will resume ${recovered} interrupted download(s) after startup.`);
    }
    setImmediate(() => this.kick());
  }

  private load(): void {
    try {
      const dir = path.dirname(JOBS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(JOBS_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(JOBS_PATH, "utf-8"));
        this.jobs = Array.isArray(parsed) ? parsed.map((j) => normalizeJob(j)) : [];
      }
    } catch (err) {
      console.error("Failed to load jobs.json:", err);
      this.jobs = [];
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(JOBS_PATH, JSON.stringify(this.jobs, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to persist jobs.json:", err);
    }
  }

  flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  private emitUpdate(immediatePersist = true): void {
    if (immediatePersist) invalidateStorageCache();
    this.emit("update", this.list());
    if (immediatePersist) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.persist();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 750);
  }

  list(): DownloadJob[] {
    return [...this.jobs].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  get(id: string): DownloadJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  resolveOutputFile(id: string): string | null {
    const job = this.get(id);
    if (!job || job.fileDeleted) return null;
    return resolveManagedFile(job.outputFile) || findCompletedFile(job.url);
  }

  enqueue(url: string): DownloadJob {
    const job: DownloadJob = {
      id: uuidv4(),
      url,
      title: null,
      status: "queued",
      progressPercent: 0,
      speed: null,
      eta: null,
      attempt: 0,
      maxAttempts: parseInt(process.env.MAX_DOWNLOAD_ATTEMPTS || "8", 10),
      lastError: null,
      outputFile: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      log: [],
      channel: null,
      channelUrl: null,
      vodDate: null,
      vodDuration: null,
      vodDurationSeconds: null,
      fileDeleted: false,
      youtubeStatus: "idle",
      youtubeVideoId: null,
      youtubeProgress: 0,
      youtubeError: null,
    };
    this.jobs.push(job);
    this.emitUpdate();
    this.kick();
    return job;
  }

  remove(id: string): boolean {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === "downloading" || job.status === "retrying") {
      return false;
    }
    if (job.youtubeStatus === "uploading") return false;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.emitUpdate();
    return true;
  }

  deleteFile(id: string): boolean {
    const job = this.get(id);
    if (!job || job.status !== "completed") return false;
    if (job.youtubeStatus === "uploading") return false;
    const filePath = this.resolveOutputFile(id);
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (err: any) {
        job.youtubeError = null;
        job.lastError = `Failed to delete file: ${err?.message || err}`;
        this.emitUpdate();
        return false;
      }
    }
    job.fileDeleted = true;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.emitUpdate();
    this.kick();
    return true;
  }

  pause(id: string): boolean {
    const job = this.get(id);
    if (!job) return false;
    if (job.status !== "downloading" && job.status !== "retrying") return false;
    if (this.currentJobId !== id || !this.abortController) return false;
    this.abortController.abort("pause");
    return true;
  }

  resume(id: string): boolean {
    const job = this.get(id);
    if (!job || job.status !== "paused") return false;
    job.status = "queued";
    job.lastError = null;
    job.speed = null;
    job.eta = null;
    this.appendLog(job, "Resumed by user.");
    this.emitUpdate();
    this.kick();
    return true;
  }

  cancel(id: string): boolean {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === "completed") return false;

    if (
      (job.status === "downloading" || job.status === "retrying") &&
      this.currentJobId === id &&
      this.abortController
    ) {
      this.abortController.abort("cancel");
      return true;
    }

    if (job.status === "downloading" || job.status === "retrying") {
      return false;
    }

    job.status = "canceled";
    job.completedAt = new Date().toISOString();
    job.speed = null;
    job.eta = null;
    job.lastError = null;
    this.appendLog(job, "Canceled by user.");
    cleanupPartialDownloads(job.url);
    this.emitUpdate();
    this.kick();
    return true;
  }

  startYoutubeUpload(id: string, meta: YoutubeUploadMeta): boolean {
    const job = this.get(id);
    if (!job || job.status !== "completed" || job.fileDeleted) return false;
    if (!isYoutubeConfigured()) return false;
    if (job.youtubeStatus === "uploading" || this.youtubeUploading.has(id)) return false;
    if (job.youtubeStatus === "uploaded" && job.youtubeVideoId) return false;
    const filePath = this.resolveOutputFile(id);
    if (!filePath) {
      job.fileDeleted = true;
      job.youtubeError = "File is missing from disk.";
      this.emitUpdate();
      return false;
    }

    job.youtubeStatus = "uploading";
    job.youtubeProgress = 0;
    job.youtubeError = null;
    this.youtubeUploading.add(id);
    this.appendLog(job, "Starting YouTube upload...");
    this.emitUpdate();

    this.runYoutubeUpload(job, filePath, meta).finally(() => {
      this.youtubeUploading.delete(id);
    });
    return true;
  }

  private async maybeAutoUpload(job: DownloadJob): Promise<void> {
    if (!isYoutubeConfigured() || job.fileDeleted) return;
    const yt = getYoutubeSettings();
    if (!yt.autoUpload) return;
    let playlistId: string | null = yt.playlistId || null;
    try {
      playlistId = await resolvePlaylistId(playlistId);
    } catch (err: any) {
      this.appendLog(
        job,
        `Auto-upload: could not resolve playlist (${err?.message || err}). Uploading without one.`
      );
      playlistId = null;
    }
    const started = this.startYoutubeUpload(job.id, {
      producer: yt.producer || "",
      observer1: yt.observer1 || "",
      observer2: yt.observer2 || "",
      playlistId,
      title: buildYoutubeTitle({ title: job.title, vodDate: job.vodDate }),
      privacy: parseYoutubePrivacy(yt.privacy),
    });
    if (!started) {
      this.appendLog(job, "Auto-upload: could not start YouTube upload.");
      this.emitUpdate();
    }
  }

  private async runYoutubeUpload(
    job: DownloadJob,
    filePath: string,
    meta: YoutubeUploadMeta
  ): Promise<void> {
    try {
      const title =
        (meta.title || "").trim().slice(0, 100) ||
        buildYoutubeTitle({ title: job.title, vodDate: job.vodDate });
      const description = buildYoutubeDescription({
        channelUrl:
          job.channelUrl || (job.channel ? `https://www.twitch.tv/${job.channel}` : null),
        producer: meta.producer,
        observer1: meta.observer1,
        observer2: meta.observer2,
      });
      const privacy = parseYoutubePrivacy(meta.privacy);
      const result = await uploadToYoutube({
        filePath,
        title,
        description,
        playlistId: meta.playlistId,
        privacy,
        onProgress: (percent) => {
          job.youtubeProgress = percent;
          job.youtubeStatus = "uploading";
          this.emitUpdate(false);
        },
      });
      job.youtubeStatus = "uploaded";
      job.youtubeProgress = 100;
      job.youtubeVideoId = result.videoId;
      job.youtubeError = result.playlistWarning
        ? `Uploaded, but adding to playlist failed: ${result.playlistWarning}`
        : null;
      this.appendLog(job, `Uploaded to YouTube: https://youtu.be/${result.videoId}`);
      if (result.playlistWarning) {
        this.appendLog(job, `Playlist add failed: ${result.playlistWarning}`);
      }
      this.emitUpdate();

      const videoUrl = `https://youtu.be/${result.videoId}`;
      if (result.playlistWarning) {
        await sendNtfyNotification({
          title: `${this.compactNtfyTitle(job)} · playlist failed`,
          message: `${job.title || title}\n${videoUrl}\nPlaylist: ${result.playlistWarning}`,
          tags: ["warning"],
          priority: 4,
        });
      } else {
        await sendNtfyNotification({
          title: `${this.compactNtfyTitle(job)} · YouTube`,
          message: `${job.title || title}\n${videoUrl}`,
          tags: ["movie_camera"],
        });
      }
    } catch (err: any) {
      job.youtubeStatus = "failed";
      job.youtubeError = err?.message || String(err);
      this.appendLog(job, `YouTube upload failed: ${job.youtubeError}`);
      this.emitUpdate();
      await sendNtfyNotification({
        title: job.channel ? `${job.channel} YouTube failed` : "YouTube upload failed",
        message: `${job.title || job.url}\n${job.youtubeError}`,
        tags: ["x"],
        priority: 4,
      });
    }
  }

  private appendLog(job: DownloadJob, line: string): void {
    job.log.push(line);
    if (job.log.length > MAX_LOG_LINES) {
      job.log = job.log.slice(job.log.length - MAX_LOG_LINES);
    }
  }

  kick(): void {
    if (this.processing) return;
    if (isStorageFull()) return;
    const next = this.jobs.find((j) => j.status === "queued");
    if (!next) return;
    this.processing = true;
    this.runJob(next).finally(() => {
      this.processing = false;
      this.abortController = null;
      this.currentJobId = null;
      setImmediate(() => this.kick());
    });
  }

  private formatNtfyDate(isoDate: string): string {
    const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return isoDate;
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  private compactNtfyTitle(job: DownloadJob): string {
    const parts = [
      job.vodDate ? this.formatNtfyDate(job.vodDate) : null,
      job.channel || "VOD",
      job.vodDuration || null,
    ].filter((part): part is string => Boolean(part));
    return parts.join(" - ");
  }

  private async runJob(job: DownloadJob): Promise<void> {
    job.status = "downloading";
    job.startedAt = job.startedAt || new Date().toISOString();
    job.completedAt = null;
    job.lastError = null;
    job.speed = null;
    job.eta = null;
    this.abortController = new DownloadController();
    this.currentJobId = job.id;
    this.emitUpdate();

    try {
      const result = await downloadVod(
        job.url,
        {
          onProgress: ({ percent, speed, eta }) => {
            job.progressPercent = percent;
            job.speed = speed;
            job.eta = eta;
            this.emitUpdate(false);
          },
          onLog: (line) => {
            this.appendLog(job, line);
            this.emitUpdate(false);
          },
          onAttempt: (attempt, maxAttempts) => {
            job.attempt = attempt;
            job.maxAttempts = maxAttempts;
            job.status = attempt > 1 ? "retrying" : "downloading";
            this.appendLog(job, `--- Attempt ${attempt}/${maxAttempts} ---`);
            this.emitUpdate();
          },
          onInfo: (info) => {
            if (info.title) job.title = info.title;
            if (info.channel) job.channel = info.channel;
            if (info.channelUrl) job.channelUrl = info.channelUrl;
            if (info.uploadDate) job.vodDate = info.uploadDate;
            if (info.durationSeconds != null) job.vodDurationSeconds = info.durationSeconds;
            if (info.durationLabel) job.vodDuration = info.durationLabel;
            this.emitUpdate(false);
          },
        },
        this.abortController
      );

      job.status = "completed";
      job.progressPercent = 100;
      job.completedAt = new Date().toISOString();
      job.outputFile = result.outputFile || findCompletedFile(job.url) || null;
      job.title = result.title || job.title;
      job.channel = result.channel || job.channel;
      job.channelUrl = result.channelUrl || job.channelUrl;
      job.vodDate = result.uploadDate || job.vodDate;
      job.vodDurationSeconds = result.durationSeconds;
      job.vodDuration =
        result.durationLabel ||
        (result.durationSeconds != null ? formatDuration(result.durationSeconds) : job.vodDuration);
      job.fileDeleted = !this.resolveOutputFile(job.id);
      job.eta = null;
      job.speed = null;
      this.emitUpdate();

      await sendNtfyNotification({
        title: this.compactNtfyTitle(job),
        message: job.title || job.url,
        tags: ["white_check_mark"],
      });
      await this.maybeAutoUpload(job);
    } catch (err: any) {
      if (err instanceof DownloadAbortError) {
        job.speed = null;
        job.eta = null;
        if (err.reason === "pause") {
          job.status = "paused";
          this.appendLog(job, "Paused by user. Partial download is kept and can be resumed.");
          this.emitUpdate();
          return;
        }
        job.status = "canceled";
        job.completedAt = new Date().toISOString();
        this.appendLog(job, "Canceled by user.");
        cleanupPartialDownloads(job.url);
        this.emitUpdate();
        return;
      }

      job.status = "failed";
      job.lastError = err?.message || String(err);
      job.completedAt = new Date().toISOString();
      this.appendLog(job, `FAILED: ${job.lastError}`);
      this.emitUpdate();

      await sendNtfyNotification({
        title: job.channel ? `${job.channel} failed` : "VOD failed",
        message: job.title || job.url,
        tags: ["x"],
        priority: 4,
      });
    }
  }

  retry(id: string): boolean {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === "downloading" || job.status === "retrying") return false;
    if (job.status === "completed") return false;
    job.status = "queued";
    job.attempt = 0;
    job.lastError = null;
    job.completedAt = null;
    this.emitUpdate();
    this.kick();
    return true;
  }
}

export const queue = new DownloadQueue();
