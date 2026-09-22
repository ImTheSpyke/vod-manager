export type JobStatus =
  | "queued"
  | "downloading"
  | "retrying"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type YoutubeStatus = "idle" | "uploading" | "uploaded" | "failed";

export interface DownloadJob {
  id: string;
  url: string;
  title: string | null;
  status: JobStatus;
  progressPercent: number;
  speed: string | null;
  eta: string | null;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  outputFile: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  log: string[];
  channel: string | null;
  channelUrl: string | null;
  vodDate: string | null;
  vodDuration: string | null;
  vodDurationSeconds: number | null;
  fileDeleted: boolean;
  youtubeStatus: YoutubeStatus;
  youtubeVideoId: string | null;
  youtubeProgress: number;
  youtubeError: string | null;
}

export type YoutubePrivacy = "public" | "unlisted" | "private";

export interface NtfySettings {
  enabled: boolean;
  server: string;
  topic: string;
  username: string;
  password: string;
  priority: number;
}

export interface YoutubeAppSettings {
  autoUpload: boolean;
  producer: string;
  observer1: string;
  observer2: string;
  playlistId: string;
  privacy: YoutubePrivacy;
}

export interface AppSettings {
  ntfy: NtfySettings;
  youtube: YoutubeAppSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  ntfy: {
    enabled: false,
    server: "https://ntfy.sh",
    topic: "twitch-vod-downloader",
    username: "",
    password: "",
    priority: 3,
  },
  youtube: {
    autoUpload: false,
    producer: "",
    observer1: "",
    observer2: "",
    playlistId: "",
    privacy: "unlisted",
  },
};
