import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import session from "express-session";
import path from "path";
import crypto from "crypto";
import { checkCredentials, requireAuth } from "./auth";
import { readSettings, writeSettings, ensureSettingsFile } from "./settings";
import { queue } from "./queue";
import {
  isYoutubeConfigured,
  hasYoutubeClient,
  listYoutubePlaylists,
  DEFAULT_YOUTUBE_PLAYLIST,
  buildYoutubeAuthUrl,
  exchangeYoutubeAuthCode,
  parseYoutubePrivacy,
} from "./youtube";
import { getStorageInfo, isStorageFull } from "./storage";

ensureSettingsFile();

if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD) {
  console.error(
    "AUTH_USERNAME and AUTH_PASSWORD must be set (via .env). Refusing to start with no credentials."
  );
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");

app.set("trust proxy", 1);
app.use(express.json());
app.use(
  session({
    name: "vod_dl_sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // "auto" sets Secure when the request is HTTPS (needs trust proxy).
      secure: "auto",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// ---------- Auth ----------

app.post("/api/login", (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  if (!checkCredentials(username, password)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/api/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.clearCookie("vod_dl_sid");
    res.json({ ok: true });
  });
});

app.get("/api/session", (req: Request, res: Response) => {
  if (req.session?.authenticated) {
    res.json({
      authenticated: true,
      username: req.session.username,
      youtubeEnabled: isYoutubeConfigured(),
      autoUpload: readSettings().youtube.autoUpload,
    });
  } else {
    res.json({ authenticated: false, youtubeEnabled: false, autoUpload: false });
  }
});

// ---------- Settings ----------

app.get("/api/settings", requireAuth, (_req: Request, res: Response) => {
  const settings = readSettings();
  res.json({
    ...settings,
    youtubeEnabled: isYoutubeConfigured(),
    youtubeClientReady: hasYoutubeClient(),
    storage: getStorageInfo(),
  });
});

app.post("/api/settings", requireAuth, (req: Request, res: Response) => {
  try {
    const updated = writeSettings(req.body || {});
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Failed to save settings" });
  }
});

function publicBaseUrl(req: Request): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || `localhost:${PORT}`)
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function youtubeOAuthRedirectUri(req: Request): string {
  const fromEnv = (process.env.YOUTUBE_REDIRECT_URI || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return `${publicBaseUrl(req)}/api/youtube/oauth/callback`;
}

function redirectHome(req: Request, res: Response, query: string): void {
  res.redirect(`${publicBaseUrl(req)}/?${query}`);
}

app.get("/api/youtube/oauth/info", requireAuth, (req: Request, res: Response) => {
  res.json({
    clientReady: hasYoutubeClient(),
    configured: isYoutubeConfigured(),
    redirectUri: youtubeOAuthRedirectUri(req),
  });
});

app.get("/api/youtube/oauth/start", requireAuth, (req: Request, res: Response) => {
  if (!hasYoutubeClient()) {
    res.status(400).send("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first.");
    return;
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = youtubeOAuthRedirectUri(req);
  req.session.youtubeOAuthState = state;
  req.session.youtubeOAuthRedirectUri = redirectUri;
  req.session.save(() => {
    res.redirect(buildYoutubeAuthUrl({ redirectUri, state }));
  });
});

app.get("/api/youtube/oauth/callback", async (req: Request, res: Response) => {
  const fail = (reason: string) => {
    redirectHome(req, res, `youtube_oauth=error&reason=${encodeURIComponent(reason)}`);
  };
  if (!req.session?.authenticated) {
    fail("Not signed in. Log in to VOD Manager first, then try again.");
    return;
  }
  const returnedState = typeof req.query.state === "string" ? req.query.state : "";
  if (!returnedState || returnedState !== req.session.youtubeOAuthState) {
    fail("OAuth state mismatch. Start again from Settings.");
    return;
  }
  const error = typeof req.query.error === "string" ? req.query.error : "";
  if (error) {
    fail(error === "access_denied" ? "Google denied access. Add your account as a test user, or publish the app." : error);
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const redirectUri = req.session.youtubeOAuthRedirectUri || youtubeOAuthRedirectUri(req);
  req.session.youtubeOAuthState = undefined;
  req.session.youtubeOAuthRedirectUri = undefined;
  if (!code) {
    fail("Google did not return an authorization code.");
    return;
  }
  try {
    const refreshToken = await exchangeYoutubeAuthCode(code, redirectUri);
    req.session.youtubeRefreshTokenPreview = refreshToken;
    req.session.save(() => {
      redirectHome(req, res, "youtube_oauth=ok");
    });
  } catch (err: any) {
    fail(err?.message || "Failed to exchange the Google code.");
  }
});

app.get("/api/youtube/oauth/result", requireAuth, (req: Request, res: Response) => {
  const token = req.session.youtubeRefreshTokenPreview || null;
  req.session.youtubeRefreshTokenPreview = undefined;
  res.json({ refreshToken: token });
});

// ---------- Jobs ----------

const TWITCH_VOD_RE = /twitch\.tv\/(?:videos\/(\d+)|\w+\/(?:video|v)\/(\d+))/i;

function isLikelyTwitchVodUrl(url: string): boolean {
  return TWITCH_VOD_RE.test(url.trim());
}

app.get("/api/storage", requireAuth, (_req: Request, res: Response) => {
  res.json(getStorageInfo());
});

app.get("/api/jobs", requireAuth, (_req: Request, res: Response) => {
  res.json(queue.list());
});

app.post("/api/jobs", requireAuth, (req: Request, res: Response) => {
  const body = req.body || {};
  const urls: string[] = Array.isArray(body.urls)
    ? body.urls
    : typeof body.url === "string"
    ? [body.url]
    : [];

  const cleaned = urls.map((u) => (u || "").trim()).filter((u) => u.length > 0);
  if (cleaned.length === 0) {
    res.status(400).json({ error: "Provide a 'url' or non-empty 'urls' array" });
    return;
  }

  if (isStorageFull()) {
    const storage = getStorageInfo();
    res.status(507).json({
      error: `Storage is full (${storage.usedLabel} / ${storage.limitLabel}). Delete files to free space.`,
      storage,
    });
    return;
  }

  const created = [];
  const rejected = [];
  for (const url of cleaned) {
    if (!isLikelyTwitchVodUrl(url)) {
      rejected.push(url);
      continue;
    }
    created.push(queue.enqueue(url));
  }

  res.status(created.length > 0 ? 201 : 400).json({ created, rejected });
});

app.post("/api/jobs/:id/retry", requireAuth, (req: Request, res: Response) => {
  const ok = queue.retry(req.params.id);
  if (!ok) {
    res.status(400).json({ error: "Job not found or currently running" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/jobs/:id/pause", requireAuth, (req: Request, res: Response) => {
  const ok = queue.pause(req.params.id);
  if (!ok) {
    res.status(400).json({ error: "Job not found or not currently downloading" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/jobs/:id/resume", requireAuth, (req: Request, res: Response) => {
  const ok = queue.resume(req.params.id);
  if (!ok) {
    res.status(400).json({ error: "Job not found or not paused" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/jobs/:id/cancel", requireAuth, (req: Request, res: Response) => {
  const ok = queue.cancel(req.params.id);
  if (!ok) {
    res.status(400).json({ error: "Job not found or cannot be canceled" });
    return;
  }
  res.json({ ok: true });
});

app.delete("/api/jobs/:id", requireAuth, (req: Request, res: Response) => {
  const ok = queue.remove(req.params.id);
  if (!ok) {
    res.status(400).json({ error: "Job not found or currently running" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/jobs/:id/file", requireAuth, (req: Request, res: Response) => {
  const filePath = queue.resolveOutputFile(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.download(filePath, path.basename(filePath));
});

app.delete("/api/jobs/:id/file", requireAuth, (req: Request, res: Response) => {
  const ok = queue.deleteFile(req.params.id);
  if (!ok) {
    res.status(400).json({ error: "File not found or cannot be deleted right now" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/youtube/playlists", requireAuth, async (_req: Request, res: Response) => {
  if (!isYoutubeConfigured()) {
    res.status(400).json({ error: "YouTube upload is not configured" });
    return;
  }
  try {
    const playlists = await listYoutubePlaylists();
    res.json({ playlists, defaultTitle: DEFAULT_YOUTUBE_PLAYLIST });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Failed to list YouTube playlists" });
  }
});

app.post("/api/jobs/:id/youtube", requireAuth, (req: Request, res: Response) => {
  if (!isYoutubeConfigured()) {
    res.status(400).json({ error: "YouTube upload is not configured" });
    return;
  }
  const body = req.body || {};
  const meta = {
    producer: typeof body.producer === "string" ? body.producer : "",
    observer1: typeof body.observer1 === "string" ? body.observer1 : "",
    observer2: typeof body.observer2 === "string" ? body.observer2 : "",
    playlistId: typeof body.playlistId === "string" && body.playlistId ? body.playlistId : null,
    title: typeof body.title === "string" ? body.title.trim().slice(0, 100) : "",
    privacy: parseYoutubePrivacy(body.privacy),
  };
  const currentYt = readSettings().youtube;
  writeSettings({
    youtube: {
      ...currentYt,
      producer: meta.producer,
      observer1: meta.observer1,
      observer2: meta.observer2,
      playlistId: meta.playlistId || "",
      privacy: meta.privacy,
    },
  });
  const ok = queue.startYoutubeUpload(req.params.id, meta);
  if (!ok) {
    res.status(400).json({ error: "Job cannot be uploaded to YouTube" });
    return;
  }
  res.status(202).json({ ok: true });
});

// Server-Sent Events stream for live job updates.
app.get("/api/events", requireAuth, (req: Request, res: Response) => {
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = () => {
    res.write(`data: ${JSON.stringify({ jobs: queue.list(), storage: getStorageInfo() })}\n\n`);
    const flush = (res as Response & { flush?: () => void }).flush;
    if (typeof flush === "function") flush.call(res);
  };

  send();
  const onUpdate = () => send();
  queue.on("update", onUpdate);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
    const flush = (res as Response & { flush?: () => void }).flush;
    if (typeof flush === "function") flush.call(res);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    queue.off("update", onUpdate);
  });
});

// ---------- Static frontend ----------

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("*", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Twitch VOD downloader listening on port ${PORT}`);
  const storage = getStorageInfo();
  console.log(`Download storage: ${storage.usedLabel} / ${storage.limitLabel}`);
  if (PUBLIC_URL) {
    console.log(`Public URL: ${PUBLIC_URL}`);
    console.log(`YouTube OAuth callback: ${PUBLIC_URL}/api/youtube/oauth/callback`);
  } else if ((process.env.YOUTUBE_REDIRECT_URI || "").trim()) {
    console.log(`YouTube OAuth callback: ${(process.env.YOUTUBE_REDIRECT_URI || "").trim()}`);
  } else {
    console.log(
      "PUBLIC_URL is not set. Set PUBLIC_URL=https://your.domain so YouTube OAuth uses the correct redirect."
    );
  }
});

const flushOnShutdown = () => {
  queue.flushPersist();
  process.exit(0);
};
process.on("SIGINT", flushOnShutdown);
process.on("SIGTERM", flushOnShutdown);
