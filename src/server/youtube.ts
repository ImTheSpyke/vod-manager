import fs from "fs";
import https from "https";
import { URL } from "url";
import { YoutubePrivacy } from "./types";

export type { YoutubePrivacy } from "./types";

// Multiple of 256 KiB as required by Google resumable uploads, except the last chunk.
const CHUNK_SIZE = 16 * 1024 * 1024;

export const DEFAULT_YOUTUBE_PLAYLIST = "Observing - Valorant";

export interface YoutubePlaylist {
  id: string;
  title: string;
}

export interface YoutubeUploadMeta {
  playlistId: string | null;
  title?: string;
  privacy?: YoutubePrivacy;
  description?: string;
}

export const YOUTUBE_OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube";

export function hasYoutubeClient(): boolean {
  return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
}

export function isYoutubeConfigured(): boolean {
  const flag = (process.env.YOUTUBE_ENABLED || "true").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no" || flag === "off") return false;
  return hasYoutubeClient() && Boolean(process.env.YOUTUBE_REFRESH_TOKEN);
}

export function buildYoutubeAuthUrl(opts: { redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || "",
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: YOUTUBE_OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeYoutubeAuthCode(code: string, redirectUri: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID || "",
      client_secret: process.env.YOUTUBE_CLIENT_SECRET || "",
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        "Google did not return a refresh token. Use prompt=consent and try again."
    );
  }
  return data.refresh_token as string;
}

export function parseYoutubePrivacy(raw: unknown): YoutubePrivacy {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "public" || value === "private" || value === "unlisted") return value;
  return "unlisted";
}

function defaultPrivacy(): YoutubePrivacy {
  return parseYoutubePrivacy(process.env.YOUTUBE_PRIVACY);
}

async function refreshAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID || "",
      client_secret: process.env.YOUTUBE_CLIENT_SECRET || "",
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN || "",
      grant_type: "refresh_token",
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to refresh YouTube access token");
  }
  return data.access_token as string;
}

async function youtubeApi(
  token: string,
  method: string,
  pathAndQuery: string,
  body?: unknown
): Promise<any> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data.error?.message || text.slice(0, 400) || `YouTube API ${res.status}`);
  }
  return data;
}

export function buildYoutubeTitle(opts: { title: string | null; vodDate: string | null }): string {
  const prefix = opts.vodDate ? `[VOD] ${opts.vodDate} - ` : "[VOD] - ";
  const rest = (opts.title || "Twitch VOD").trim();
  return (prefix + rest).slice(0, 100);
}

export function buildYoutubeDescription(channelUrl: string | null | undefined): string {
  const url = (channelUrl || "").trim();
  return `twitch channel: ${url}\n\nProducer:\nObserver 1:\nObserver 2:\n`;
}

async function startResumableSession(
  token: string,
  fileSize: number,
  title: string,
  description: string,
  privacy: YoutubePrivacy
): Promise<string> {
  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(fileSize),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: title.slice(0, 100),
          description: description.slice(0, 5000),
          categoryId: "20",
        },
        status: {
          privacyStatus: privacy,
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube init failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const location = res.headers.get("location") || res.headers.get("Location");
  if (!location) throw new Error("YouTube did not return an upload URL");
  return location;
}

function putChunk(
  uploadUrl: string,
  token: string,
  buf: Buffer,
  start: number,
  total: number
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const end = start + buf.length - 1;
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Length": buf.length,
          "Content-Type": "video/mp4",
          "Content-Range": `bytes ${start}-${end}/${total}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

async function listAllPlaylists(token: string): Promise<YoutubePlaylist[]> {
  const playlists: YoutubePlaylist[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({
      part: "snippet",
      mine: "true",
      maxResults: "50",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const data = await youtubeApi(token, "GET", `playlists?${query.toString()}`);
    for (const item of data.items || []) {
      playlists.push({
        id: item.id,
        title: item.snippet?.title || "Untitled playlist",
      });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return playlists;
}

async function createPlaylist(token: string, title: string): Promise<YoutubePlaylist> {
  const data = await youtubeApi(token, "POST", "playlists?part=snippet,status", {
    snippet: { title },
    status: { privacyStatus: "unlisted" },
  });
  return { id: data.id, title: data.snippet?.title || title };
}

export async function listYoutubePlaylists(): Promise<YoutubePlaylist[]> {
  if (!isYoutubeConfigured()) {
    throw new Error("YouTube upload is not configured");
  }
  const token = await refreshAccessToken();
  const playlists = await listAllPlaylists(token);
  const hasDefault = playlists.some(
    (p) => p.title.trim().toLowerCase() === DEFAULT_YOUTUBE_PLAYLIST.toLowerCase()
  );
  if (!hasDefault) {
    playlists.unshift(await createPlaylist(token, DEFAULT_YOUTUBE_PLAYLIST));
  }
  return playlists.sort((a, b) => a.title.localeCompare(b.title));
}

export async function resolvePlaylistId(preferredId?: string | null): Promise<string | null> {
  const playlists = await listYoutubePlaylists();
  if (preferredId && playlists.some((p) => p.id === preferredId)) return preferredId;
  const match = playlists.find(
    (p) => p.title.trim().toLowerCase() === DEFAULT_YOUTUBE_PLAYLIST.toLowerCase()
  );
  return match?.id || null;
}

async function addVideoToPlaylist(token: string, playlistId: string, videoId: string): Promise<void> {
  await youtubeApi(token, "POST", "playlistItems?part=snippet", {
    snippet: {
      playlistId,
      resourceId: {
        kind: "youtube#video",
        videoId,
      },
    },
  });
}

export async function uploadToYoutube(opts: {
  filePath: string;
  title: string;
  description: string;
  playlistId?: string | null;
  privacy?: YoutubePrivacy;
  onProgress: (percent: number) => void;
}): Promise<{ videoId: string; playlistWarning: string | null }> {
  if (!isYoutubeConfigured()) {
    throw new Error("YouTube upload is not configured (.env YOUTUBE_* variables)");
  }

  let token = await refreshAccessToken();
  const stat = fs.statSync(opts.filePath);
  const privacy = parseYoutubePrivacy(opts.privacy ?? defaultPrivacy());
  const uploadUrl = await startResumableSession(
    token,
    stat.size,
    opts.title,
    opts.description,
    privacy
  );

  const fd = fs.openSync(opts.filePath, "r");
  let videoId: string | null = null;
  try {
    let offset = 0;
    while (offset < stat.size) {
      const toRead = Math.min(CHUNK_SIZE, stat.size - offset);
      const buf = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      const chunk = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);

      let result = await putChunk(uploadUrl, token, chunk, offset, stat.size);
      if (result.status === 401) {
        token = await refreshAccessToken();
        result = await putChunk(uploadUrl, token, chunk, offset, stat.size);
      }

      if (result.status === 308) {
        offset += chunk.length;
        opts.onProgress(Math.min(99, (offset / stat.size) * 100));
        continue;
      }
      if (result.status === 200 || result.status === 201) {
        const parsed = JSON.parse(result.body || "{}");
        videoId = parsed.id || null;
        opts.onProgress(100);
        break;
      }
      throw new Error(`YouTube upload failed (${result.status}): ${result.body.slice(0, 400)}`);
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!videoId) throw new Error("YouTube upload finished without a video id");

  let playlistWarning: string | null = null;
  if (opts.playlistId) {
    try {
      token = await refreshAccessToken();
      await addVideoToPlaylist(token, opts.playlistId, videoId);
    } catch (err: any) {
      playlistWarning = err?.message || String(err);
    }
  }

  return { videoId, playlistWarning };
}
