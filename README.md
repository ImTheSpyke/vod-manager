# Twitch VOD Downloader

A small self-hosted webapp to queue up Twitch VOD links and download them at
the best available quality (usually 1080p60), one at a time, with automatic
retries (including backing off on HTTP 429 rate limiting) and an NTFY
notification when each download finishes.

Downloading itself is done by [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
(installed in the Docker image) — it's the most robust tool for this and
handles Twitch's split video/audio streams, fragment retries, and format
selection.

## Quick start

1. Copy the example env file and set your login + a random session secret:

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:
   ```
   AUTH_USERNAME=your-username
   AUTH_PASSWORD=a-strong-password
   SESSION_SECRET=<output of: openssl rand -hex 32>
   ```

2. Start it:

   ```bash
   docker compose up -d --build
   ```

3. Open `http://localhost:3000`, log in, paste a VOD link (e.g.
   `https://www.twitch.tv/videos/2880295967`) and click **Get VOD**.

Downloaded files land in `./downloads` on the host. Job history persists in
`./data/jobs.json` (survives restarts). NTFY config lives in
`./config/settings.json` on the host, and is also editable from the app's
**Settings** panel — both stay in sync since it's a bind mount.

## Configuring notifications (NTFY)

Open **Settings** in the app, or edit `./config/settings.json` directly:

```json
{
  "ntfy": {
    "enabled": true,
    "server": "https://ntfy.sh",
    "topic": "twitch-vod-downloader",
    "username": "",
    "password": "",
    "priority": 3
  }
}
```

Point `server`/`topic` at your own NTFY instance and topic. `username`/
`password` are only needed if your NTFY server requires auth. A notification
is sent on both success and failure of each download.

## Queueing multiple VODs

Paste multiple links into the box, one per line, and click **Get VOD** — all
of them are added to the queue and downloaded strictly one at a time, so
you never hit Twitch/CDN rate limits from concurrent downloads. Live
progress (percent, speed, ETA, attempt count) streams into the UI as each
job runs.

## How retries work

- Each download attempt runs `yt-dlp` with its own internal fragment-level
  retries.
- If the whole process fails (network drop, transient error), the queue
  retries the job up to `MAX_DOWNLOAD_ATTEMPTS` (default 8) times with
  increasing backoff (10s, 30s, 60s, 2m, 5m...).
- If Twitch/Cloudfront responds with HTTP 429 (rate limited), it backs off
  for 10 minutes before retrying, and doesn't burn through the attempt
  budget as fast, so a temporary rate limit won't mark the job as failed.
- A permanently failed job can be retried manually from the UI, or removed
  from the queue.

## Project layout

```
src/server/      Express backend (auth, settings, queue, downloader, NTFY)
src/frontend/    Plain TypeScript + HTML/CSS frontend (no framework)
config/          settings.json (bind-mounted)
downloads/       Finished .mp4 files (bind-mounted)
data/            jobs.json queue/history (bind-mounted)
```

## Running without Docker (development)

Requires Node 20+, Python 3, `ffmpeg`, and `yt-dlp` on your PATH.

```bash
npm install
npm run build
npm start
```

## Security note

Auth is intentionally minimal per the brief: a single username/password
pair from `.env`, checked with a timing-safe comparison, backing an
HTTP-only session cookie. There's no user management, rate limiting on
login attempts, or HTTPS termination built in — put this behind a reverse
proxy (e.g. Caddy/Traefik/nginx) with TLS if exposing it beyond your LAN.
