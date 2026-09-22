import { getNtfySettings } from "./settings";

export interface NotifyOptions {
  title: string;
  message: string;
  tags?: string[];
  priority?: number;
}

export async function sendNtfyNotification(opts: NotifyOptions): Promise<void> {
  const ntfy = getNtfySettings();
  if (!ntfy.enabled || !ntfy.server || !ntfy.topic) {
    return;
  }

  const url = `${ntfy.server.replace(/\/+$/, "")}/${encodeURIComponent(ntfy.topic)}`;

  const headers: Record<string, string> = {
    Title: opts.title,
    Priority: String(opts.priority ?? ntfy.priority ?? 3),
  };
  if (opts.tags && opts.tags.length > 0) {
    headers.Tags = opts.tags.join(",");
  }
  if (ntfy.username && ntfy.password) {
    const basic = Buffer.from(`${ntfy.username}:${ntfy.password}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: opts.message,
    });
    if (!res.ok) {
      console.error(`NTFY notification failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("NTFY notification error:", err);
  }
}
