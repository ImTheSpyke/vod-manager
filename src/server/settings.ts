import fs from "fs";
import path from "path";
import { AppSettings, DEFAULT_SETTINGS, NtfySettings, YoutubePrivacy } from "./types";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const CONFIGURED_SETTINGS_PATH =
  process.env.SETTINGS_PATH || path.join(__dirname, "..", "..", "config", "settings.json");
const DATA_SETTINGS_PATH = path.join(
  path.dirname(process.env.JOBS_PATH || path.join(__dirname, "..", "..", "data", "jobs.json")),
  "settings.json"
);

function isDirectory(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveSettingsPath(): string {
  // Docker bind-mounts a missing host file as a directory; that mount cannot be
  // removed from inside the container (EBUSY). Persist next to jobs.json instead.
  if (isDirectory(CONFIGURED_SETTINGS_PATH)) {
    console.warn(
      `${CONFIGURED_SETTINGS_PATH} is a directory (Docker bind-mounted a missing file). ` +
        `Using ${DATA_SETTINGS_PATH}. On the host run:\n` +
        `  docker compose down\n` +
        `  rm -rf ./config/settings.json\n` +
        `  mkdir -p ./config ./data ./downloads\n` +
        `  docker compose up -d --force-recreate`
    );
    return DATA_SETTINGS_PATH;
  }
  return CONFIGURED_SETTINGS_PATH;
}

const SETTINGS_PATH = resolveSettingsPath();

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const key of Object.keys(override || {})) {
    const overrideVal = (override as any)[key];
    const baseVal = (base as any)[key];
    if (
      overrideVal &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      baseVal &&
      typeof baseVal === "object"
    ) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result;
}

export function ensureSettingsFile(): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (isDirectory(SETTINGS_PATH)) {
    throw new Error(
      `${SETTINGS_PATH} is a directory. Delete it on the host and remount ./config as a folder.`
    );
  }
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf-8");
  }
}

export function readSettings(): AppSettings {
  ensureSettingsFile();
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_SETTINGS, parsed);
  } catch (err) {
    console.error("Failed to read settings.json, falling back to defaults:", err);
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(partial: DeepPartial<AppSettings>): AppSettings {
  const current = readSettings();
  const merged = deepMerge(current, partial as Partial<AppSettings>);
  if (merged.youtube) {
    merged.youtube.autoUpload = Boolean(merged.youtube.autoUpload);
    const privacy = String(merged.youtube.privacy || "unlisted").toLowerCase();
    merged.youtube.privacy = (
      privacy === "public" || privacy === "private" || privacy === "unlisted" ? privacy : "unlisted"
    ) as YoutubePrivacy;
    merged.youtube.producer = String(merged.youtube.producer || "");
    merged.youtube.observer1 = String(merged.youtube.observer1 || "");
    merged.youtube.observer2 = String(merged.youtube.observer2 || "");
    merged.youtube.playlistId = String(merged.youtube.playlistId || "");
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

export function getNtfySettings(): NtfySettings {
  return readSettings().ntfy;
}

export function getYoutubeSettings() {
  return readSettings().youtube;
}

export function settingsPath(): string {
  return SETTINGS_PATH;
}
