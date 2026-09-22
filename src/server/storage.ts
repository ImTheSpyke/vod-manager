import fs from "fs";
import path from "path";
import { DOWNLOAD_DIR } from "./downloader";

const GIB = 1024 * 1024 * 1024;

function parseLimitBytes(): number {
  const gb = parseFloat(process.env.STORAGE_LIMIT_GB || "30");
  if (Number.isFinite(gb) && gb > 0) return Math.round(gb * GIB);
  return 30 * GIB;
}

export const STORAGE_LIMIT_BYTES = parseLimitBytes();

export interface StorageInfo {
  usedBytes: number;
  limitBytes: number;
  usedLabel: string;
  limitLabel: string;
  percent: number;
  full: boolean;
}

let cache: { at: number; info: StorageInfo } | null = null;
const CACHE_MS = 1500;

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) {
    const gb = bytes / GIB;
    return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  if (bytes <= 0) return "0 B";
  return `${Math.round(bytes / 1024)} KB`;
}

export function getStorageInfo(force = false): StorageInfo {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.info;
  const usedBytes = dirSize(DOWNLOAD_DIR);
  const limitBytes = STORAGE_LIMIT_BYTES;
  const percent = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  const info: StorageInfo = {
    usedBytes,
    limitBytes,
    usedLabel: formatBytes(usedBytes),
    limitLabel: formatBytes(limitBytes),
    percent: Math.round(percent * 10) / 10,
    full: usedBytes >= limitBytes,
  };
  cache = { at: Date.now(), info };
  return info;
}

export function invalidateStorageCache(): void {
  cache = null;
}

export function isStorageFull(): boolean {
  return getStorageInfo().full;
}
