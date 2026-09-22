interface DownloadJob {
  id: string;
  url: string;
  title: string | null;
  status: "queued" | "downloading" | "retrying" | "paused" | "completed" | "failed" | "canceled";
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
  vodSizeBytes: number | null;
  vodSizeLabel: string | null;
  ignoreStorageLimit: boolean;
  pausedForStorage: boolean;
  storageOverByBytes: number | null;
  storageOverByLabel: string | null;
  fileDeleted: boolean;
  youtubeStatus: "idle" | "uploading" | "uploaded" | "failed";
  youtubeVideoId: string | null;
  youtubeProgress: number;
  youtubeError: string | null;
}

interface NtfySettings {
  enabled: boolean;
  server: string;
  topic: string;
  username: string;
  password: string;
  priority: number;
}

interface YoutubeAppSettings {
  autoUpload: boolean;
  playlistId: string;
  privacy: "public" | "unlisted" | "private";
}

interface AppSettings {
  ntfy: NtfySettings;
  youtube?: YoutubeAppSettings;
}

interface StorageInfo {
  usedBytes: number;
  limitBytes: number;
  usedLabel: string;
  limitLabel: string;
  percent: number;
  full: boolean;
}

interface StreamPayload {
  jobs: DownloadJob[];
  storage: StorageInfo;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const loginView = $<HTMLElement>("login-view");
const mainView = $<HTMLElement>("main-view");
const loginForm = $<HTMLFormElement>("login-form");
const loginError = $<HTMLParagraphElement>("login-error");
const whoami = $<HTMLSpanElement>("whoami");
const logoutBtn = $<HTMLButtonElement>("logout-btn");

const urlInput = $<HTMLTextAreaElement>("url-input");
const addBtn = $<HTMLButtonElement>("add-btn");
const addError = $<HTMLDivElement>("add-error");
const jobList = $<HTMLDivElement>("job-list");

const settingsBtn = $<HTMLButtonElement>("settings-btn");
const settingsModal = $<HTMLDivElement>("settings-modal");
const settingsForm = $<HTMLFormElement>("settings-form");
const settingsCancel = $<HTMLButtonElement>("settings-cancel");
const settingsError = $<HTMLDivElement>("settings-error");

const youtubeModal = $<HTMLDivElement>("youtube-modal");
const youtubeForm = $<HTMLFormElement>("youtube-form");
const youtubeCancel = $<HTMLButtonElement>("youtube-cancel");
const youtubeSubmit = $<HTMLButtonElement>("youtube-submit");
const youtubeError = $<HTMLDivElement>("youtube-error");
const ytTitle = $<HTMLInputElement>("yt-title");
const ytTitleCount = $<HTMLSpanElement>("yt-title-count");
const ytPrivacy = $<HTMLSelectElement>("yt-privacy");
const ytDescription = $<HTMLTextAreaElement>("yt-description");
const ytPlaylist = $<HTMLSelectElement>("yt-playlist");
const autoUploadWrap = $<HTMLLabelElement>("auto-upload-wrap");
const autoUploadToggle = $<HTMLInputElement>("auto-upload-toggle");
const ytAutoUpload = $<HTMLInputElement>("yt-auto-upload");

let eventSource: EventSource | null = null;
let hydrateTimer: number | null = null;
let reconnectTimer: number | null = null;
let youtubeEnabled = false;
let autoUploadEnabled = false;
let youtubeJobId: string | null = null;
const YT_FORM_KEY = "vod-manager-youtube-form";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && (data as any).error) || `Request failed (${res.status})`);
  }
  return data as T;
}

function showView(view: "login" | "main"): void {
  loginView.classList.toggle("hidden", view !== "login");
  mainView.classList.toggle("hidden", view !== "main");
}

async function checkSession(): Promise<void> {
  const data = await api<{
    authenticated: boolean;
    username?: string;
    youtubeEnabled?: boolean;
    autoUpload?: boolean;
  }>("/api/session");
  if (data.authenticated) {
    youtubeEnabled = !!data.youtubeEnabled;
    autoUploadEnabled = !!data.autoUpload;
    syncAutoUploadUi();
    whoami.textContent = data.username ? `Signed in as ${data.username}` : "";
    showView("main");
    void hydrateDashboard();
    startEventStream();
    loadSettingsIntoForm().catch(() => void 0);
    handleYoutubeOauthReturn().catch(() => void 0);
  } else {
    showView("login");
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  const username = $<HTMLInputElement>("login-username").value;
  const password = $<HTMLInputElement>("login-password").value;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
    loginForm.reset();
    await checkSession();
  } catch (err: any) {
    loginError.textContent = err.message || "Login failed";
    loginError.classList.remove("hidden");
  }
});

logoutBtn.addEventListener("click", async () => {
  stopEventStream();
  await api("/api/logout", { method: "POST" });
  showView("login");
});

async function hydrateDashboard(): Promise<void> {
  try {
    const [jobs, storage] = await Promise.all([
      api<DownloadJob[]>("/api/jobs"),
      api<StorageInfo>("/api/storage").catch(() => null),
    ]);
    if (Array.isArray(jobs)) renderJobs(jobs);
    if (storage) renderStorage(storage);
  } catch {
    /* live stream may still fill in */
  }
}

function scheduleHydrate(): void {
  if (hydrateTimer != null) return;
  hydrateTimer = window.setTimeout(() => {
    hydrateTimer = null;
    void hydrateDashboard();
  }, 400);
}

function stopEventStream(): void {
  if (reconnectTimer != null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (hydrateTimer != null) {
    window.clearTimeout(hydrateTimer);
    hydrateTimer = null;
  }
  eventSource?.close();
  eventSource = null;
}

function applyStreamPayload(payload: StreamPayload | DownloadJob[]): void {
  if (Array.isArray(payload)) {
    renderJobs(payload);
    return;
  }
  if (payload.storage) renderStorage(payload.storage);
  if (Array.isArray(payload.jobs)) renderJobs(payload.jobs);
}

function startEventStream(): void {
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;
  eventSource?.close();
  eventSource = new EventSource("/api/events");
  eventSource.onmessage = (evt) => {
    if (!evt.data) return;
    try {
      applyStreamPayload(JSON.parse(evt.data) as StreamPayload | DownloadJob[]);
    } catch {
      scheduleHydrate();
    }
  };
  eventSource.onerror = () => {
    scheduleHydrate();
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      eventSource.close();
      eventSource = null;
      if (reconnectTimer != null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        startEventStream();
      }, 2000);
    }
  };
}

function statusLabel(job: DownloadJob): string {
  switch (job.status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "retrying":
      return `Retrying (${job.attempt}/${job.maxAttempts})`;
    case "paused":
      return isStorageHold(job) ? "Won't fit" : "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}

function progressWidth(job: DownloadJob): number {
  if (job.status === "completed") return 100;
  if (job.status === "queued" && !(job.progressPercent > 0)) return 0;
  return Math.max(0, Math.min(100, job.progressPercent || 0));
}

function progressLabel(job: DownloadJob): string {
  if (job.status === "canceled") return "Canceled";
  if (job.status === "queued" && !(job.progressPercent > 0)) return "Waiting";
  const pct = progressWidth(job);
  const rounded = pct >= 10 || pct === 0 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded}%`;
}

function isActive(job: DownloadJob): boolean {
  return job.status === "downloading" || job.status === "retrying";
}

function isStorageHold(job: DownloadJob): boolean {
  if (job.status !== "paused") return false;
  if (job.pausedForStorage || !!job.storageOverByLabel) return true;
  return job.log.some((line) => /would exceed storage/i.test(line));
}

function hasDownloadedFile(job: DownloadJob): boolean {
  return job.status === "completed" && !job.fileDeleted;
}

function jobMetaItems(job: DownloadJob): string[] {
  const meta: string[] = [];
  if (job.vodDate) meta.push(job.vodDate);
  if (job.vodDuration) meta.push(job.vodDuration);
  if (job.vodSizeLabel) meta.push(job.vodSizeLabel);
  if (isActive(job)) {
    if (job.speed) meta.push(job.speed);
    if (job.eta) meta.push(`ETA ${job.eta}`);
    meta.push(`Attempt ${job.attempt || 1}/${job.maxAttempts}`);
  }
  if (job.status === "paused" && !isStorageHold(job)) {
    meta.push("Partial download kept — resume to continue");
  }
  if (job.status === "completed") {
    if (job.youtubeStatus === "uploading") {
      meta.push(`YouTube ${Math.round(job.youtubeProgress || 0)}%`);
    } else if (job.youtubeStatus === "uploaded") {
      meta.push("On YouTube");
    }
    if (job.fileDeleted) meta.push("File deleted");
    if (job.completedAt) meta.push(`Finished ${new Date(job.completedAt).toLocaleString()}`);
  }
  return meta;
}

function actionSignature(job: DownloadJob): string {
  const active = isActive(job);
  const actions: string[] = [];
  if (active) actions.push("pause");
  if (job.status === "paused") {
    actions.push(isStorageHold(job) ? "anyway,resume" : "resume");
  }
  if (active || job.status === "queued" || job.status === "paused") actions.push("cancel");
  if (hasDownloadedFile(job)) {
    actions.push("download");
    if (job.youtubeStatus === "uploaded" && job.youtubeVideoId) actions.push("youtube-open");
    else if (job.youtubeStatus === "uploading") actions.push("youtube-busy");
    else if (youtubeEnabled) actions.push("youtube");
    if (job.youtubeStatus !== "uploading") actions.push("delete-file");
  }
  if (job.status === "failed" || job.status === "canceled") actions.push("retry");
  if (!active && job.youtubeStatus !== "uploading" && !hasDownloadedFile(job)) {
    actions.push("delete");
  }
  return actions.join(",");
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function renderStorage(info: StorageInfo): void {
  const fill = $<HTMLDivElement>("storage-fill");
  const label = $<HTMLSpanElement>("storage-label");
  const hint = $<HTMLParagraphElement>("storage-full-hint");
  setText(label, `${info.usedLabel} / ${info.limitLabel}`);
  const width = `${Math.min(100, Math.max(0, info.percent))}%`;
  if (fill.style.width !== width) fill.style.width = width;
  fill.classList.toggle("storage-warn", info.percent >= 80 && info.percent < 95 && !info.full);
  fill.classList.toggle("storage-full", info.full || info.percent >= 95);
  hint.classList.toggle("hidden", !info.full);
}

function syncAutoUploadUi(): void {
  autoUploadWrap.classList.toggle("hidden", !youtubeEnabled);
  autoUploadToggle.checked = autoUploadEnabled;
  ytAutoUpload.checked = autoUploadEnabled;
}

function createActionButton(
  jobId: string,
  action: string,
  label: string,
  className?: string
): HTMLButtonElement {
  const btn = document.createElement("button");
  if (className) btn.className = className;
  btn.dataset.action = action;
  btn.dataset.id = jobId;
  btn.textContent = label;
  return btn;
}

function createActionLink(
  href: string,
  label: string,
  className?: string,
  opts: { download?: boolean; external?: boolean } = {}
): HTMLAnchorElement {
  const a = document.createElement("a");
  if (className) a.className = className;
  a.href = href;
  a.textContent = label;
  if (opts.download) a.setAttribute("download", "");
  if (opts.external) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return a;
}

function renderActions(container: HTMLElement, job: DownloadJob): void {
  const sig = actionSignature(job);
  if (container.dataset.actions === sig) return;
  container.dataset.actions = sig;
  container.replaceChildren();
  const active = isActive(job);
  if (active) container.appendChild(createActionButton(job.id, "pause", "Pause", "secondary"));
  if (job.status === "paused") {
    if (isStorageHold(job)) {
      container.appendChild(createActionButton(job.id, "anyway", "Continue anyway"));
      container.appendChild(createActionButton(job.id, "resume", "Resume", "secondary"));
    } else {
      container.appendChild(createActionButton(job.id, "resume", "Resume"));
    }
  }
  if (active || job.status === "queued" || job.status === "paused") {
    container.appendChild(createActionButton(job.id, "cancel", "Cancel", "danger"));
  }
  if (hasDownloadedFile(job)) {
    container.appendChild(
      createActionLink(`/api/jobs/${job.id}/file`, "Download", undefined, { download: true })
    );
    if (job.youtubeStatus === "uploaded" && job.youtubeVideoId) {
      container.appendChild(
        createActionLink(`https://youtu.be/${job.youtubeVideoId}`, "Open YouTube", "secondary", {
          external: true,
        })
      );
    } else if (job.youtubeStatus === "uploading") {
      const busy = createActionButton(job.id, "youtube", "Uploading…", "secondary");
      busy.disabled = true;
      container.appendChild(busy);
    } else if (youtubeEnabled) {
      container.appendChild(createActionButton(job.id, "youtube", "Upload to YouTube"));
    }
    if (job.youtubeStatus !== "uploading") {
      container.appendChild(createActionButton(job.id, "delete-file", "Delete file", "danger"));
    }
  }
  if (job.status === "failed" || job.status === "canceled") {
    container.appendChild(createActionButton(job.id, "retry", "Retry", "secondary"));
  }
  if (!active && job.youtubeStatus !== "uploading" && !hasDownloadedFile(job)) {
    container.appendChild(createActionButton(job.id, "delete", "Remove", "secondary"));
  }
}

function storageWarningText(job: DownloadJob): string {
  if (!isStorageHold(job)) return "";
  const size = job.vodSizeLabel ? `This VOD is ${job.vodSizeLabel} and ` : "This VOD ";
  if (job.storageOverByLabel) return `${size}would exceed storage by ${job.storageOverByLabel}.`;
  return `${size}would exceed the storage limit.`;
}

function updateLog(card: HTMLElement, job: DownloadJob): void {
  let details = card.querySelector("details.job-log") as HTMLDetailsElement | null;
  const lines = job.log.slice(-30);
  if (lines.length === 0) {
    details?.remove();
    return;
  }
  if (!details) {
    details = document.createElement("details");
    details.className = "job-log";
    const summary = document.createElement("summary");
    const pre = document.createElement("pre");
    details.append(summary, pre);
    card.appendChild(details);
  }
  const summary = details.querySelector("summary") as HTMLElement;
  const pre = details.querySelector("pre") as HTMLElement;
  setText(summary, `Log (last ${lines.length} line${lines.length === 1 ? "" : "s"})`);
  const text = lines.join("\n");
  if (pre.textContent === text) return;
  const nearBottom = details.open && pre.scrollHeight - pre.scrollTop - pre.clientHeight < 32;
  pre.textContent = text;
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
}

function updateJobCard(card: HTMLElement, job: DownloadJob): void {
  const active = isActive(job);
  const className = `job job-${job.status}`;
  if (card.className !== className) card.className = className;

  setText(card.querySelector(".job-title") as HTMLElement, job.title || job.url);
  const subtitle = job.channel ? `${job.channel} · ${job.url}` : job.url;
  setText(card.querySelector(".job-url") as HTMLElement, subtitle);

  const badge = card.querySelector(".badge") as HTMLElement;
  badge.className = `badge badge-${job.status}`;
  setText(badge, statusLabel(job));

  const fill = card.querySelector(".progress-fill") as HTMLElement;
  fill.classList.toggle("progress-fill-active", active);
  const width = `${progressWidth(job)}%`;
  if (fill.style.width !== width) fill.style.width = width;
  setText(card.querySelector(".progress-pct") as HTMLElement, progressLabel(job));

  const metaEl = card.querySelector(".job-meta") as HTMLElement;
  const meta = jobMetaItems(job);
  const metaKey = meta.join("\0");
  if (metaEl.dataset.meta !== metaKey) {
    metaEl.dataset.meta = metaKey;
    metaEl.replaceChildren();
    for (const item of meta) {
      const span = document.createElement("span");
      span.textContent = item;
      metaEl.appendChild(span);
    }
  }
  metaEl.classList.toggle("hidden", meta.length === 0);

  const warnEl = card.querySelector(".job-warning") as HTMLElement | null;
  const warning = storageWarningText(job);
  if (warnEl) {
    setText(warnEl, warning);
    warnEl.classList.toggle("hidden", !warning);
  }

  const errorText = [job.lastError, job.youtubeError].filter(Boolean).join("\n");
  const errorEl = card.querySelector(".job-error") as HTMLElement;
  setText(errorEl, errorText);
  errorEl.classList.toggle("hidden", !errorText);

  renderActions(card.querySelector(".job-actions") as HTMLElement, job);
  updateLog(card, job);
}

function createJobCard(job: DownloadJob): HTMLElement {
  const card = document.createElement("div");
  card.dataset.id = job.id;
  card.innerHTML =
    '<div class="job-header"><div><div class="job-title"></div><div class="job-url"></div></div><span class="badge"></span></div>' +
    '<div class="progress-row"><div class="progress-track"><div class="progress-fill"></div></div><span class="progress-pct"></span></div>' +
    '<div class="job-meta"></div><div class="job-warning"></div><div class="job-error"></div><div class="job-actions"></div>';
  updateJobCard(card, job);
  return card;
}

function renderJobs(jobs: DownloadJob[]): void {
  const ordered = jobs.slice().reverse();

  if (ordered.length === 0) {
    if (!jobList.querySelector(".empty-state") || jobList.children.length !== 1) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No downloads yet.";
      jobList.replaceChildren(p);
    }
    return;
  }

  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(jobList.children)) {
    if (!(child instanceof HTMLElement) || !child.dataset.id) {
      child.remove();
      continue;
    }
    existing.set(child.dataset.id, child);
  }

  const used = new Set<string>();
  ordered.forEach((job, index) => {
    used.add(job.id);
    let card = existing.get(job.id);
    if (!card) {
      card = createJobCard(job);
    } else {
      updateJobCard(card, job);
    }
    const current = jobList.children[index];
    if (current !== card) {
      jobList.insertBefore(card, current || null);
    }
  });

  for (const [id, card] of existing) {
    if (!used.has(id)) card.remove();
  }
}

jobList.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const action = target.getAttribute("data-action");
  const id = target.getAttribute("data-id");
  if (!action || !id) return;
  if (action === "cancel") {
    const ok = window.confirm("Cancel this download? Partial files will be removed.");
    if (!ok) return;
  }
  if (action === "delete-file") {
    const ok = window.confirm("Delete the downloaded video file from disk? This cannot be undone.");
    if (!ok) return;
  }
  target.setAttribute("disabled", "true");
  try {
    if (action === "retry") {
      await api(`/api/jobs/${id}/retry`, { method: "POST" });
    } else if (action === "pause") {
      await api(`/api/jobs/${id}/pause`, { method: "POST" });
    } else if (action === "resume") {
      await api(`/api/jobs/${id}/resume`, { method: "POST" });
    } else if (action === "anyway") {
      await api(`/api/jobs/${id}/resume`, { method: "POST", body: JSON.stringify({ anyway: true }) });
    } else if (action === "cancel") {
      await api(`/api/jobs/${id}/cancel`, { method: "POST" });
    } else if (action === "youtube") {
      await openYoutubeModal(id);
    } else if (action === "delete-file") {
      await api(`/api/jobs/${id}/file`, { method: "DELETE" });
    } else if (action === "delete") {
      await api(`/api/jobs/${id}`, { method: "DELETE" });
    }
  } catch (err) {
    console.error(err);
  } finally {
    target.removeAttribute("disabled");
  }
});

addBtn.addEventListener("click", async () => {
  addError.classList.add("hidden");
  const raw = urlInput.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) {
    addError.textContent = "Enter at least one Twitch VOD link.";
    addError.classList.remove("hidden");
    return;
  }
  addBtn.setAttribute("disabled", "true");
  try {
    const result = await api<{ created: DownloadJob[]; rejected: string[] }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ urls: raw }),
    });
    if (result.rejected?.length) {
      addError.textContent = `Skipped ${result.rejected.length} link(s) that didn't look like Twitch VOD URLs.`;
      addError.classList.remove("hidden");
    }
    urlInput.value = "";
  } catch (err: any) {
    addError.textContent = err.message || "Failed to add download";
    addError.classList.remove("hidden");
  } finally {
    addBtn.removeAttribute("disabled");
  }
});

// ---------- Settings modal ----------

async function loadSettingsIntoForm(): Promise<void> {
  const settings = await api<
    AppSettings & { youtubeEnabled?: boolean; youtubeClientReady?: boolean; storage?: StorageInfo }
  >("/api/settings");
  if (typeof settings.youtubeEnabled === "boolean") {
    youtubeEnabled = settings.youtubeEnabled;
  }
  autoUploadEnabled = !!settings.youtube?.autoUpload;
  syncAutoUploadUi();
  if (settings.storage) renderStorage(settings.storage);
  $<HTMLInputElement>("ntfy-enabled").checked = settings.ntfy.enabled;
  $<HTMLInputElement>("ntfy-server").value = settings.ntfy.server;
  $<HTMLInputElement>("ntfy-topic").value = settings.ntfy.topic;
  $<HTMLInputElement>("ntfy-username").value = settings.ntfy.username;
  $<HTMLInputElement>("ntfy-password").value = settings.ntfy.password;
  $<HTMLInputElement>("ntfy-priority").value = String(settings.ntfy.priority);
  await loadYoutubeOauthInfo();
}

async function loadYoutubeOauthInfo(): Promise<void> {
  const info = await api<{ clientReady: boolean; configured: boolean; redirectUri: string }>(
    "/api/youtube/oauth/info"
  );
  $<HTMLInputElement>("yt-redirect-uri").value = info.redirectUri;
  const status = $<HTMLParagraphElement>("yt-oauth-status");
  const authBtn = $<HTMLButtonElement>("yt-authorize-btn");
  authBtn.disabled = !info.clientReady;
  if (!info.clientReady) {
    status.textContent = "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first, then restart.";
  } else if (info.configured) {
    status.textContent = "YouTube is configured. Authorize again only if uploads start failing.";
  } else {
    status.textContent = "Client is set. Authorize to get a refresh token.";
  }
}

async function handleYoutubeOauthReturn(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("youtube_oauth");
  if (!result) return;
  const reason = params.get("reason") || "";
  window.history.replaceState({}, "", window.location.pathname);
  settingsModal.classList.remove("hidden");
  await loadYoutubeOauthInfo().catch(() => void 0);
  const tokenWrap = $<HTMLDivElement>("yt-token-wrap");
  const tokenField = $<HTMLTextAreaElement>("yt-refresh-token");
  const status = $<HTMLParagraphElement>("yt-oauth-status");
  if (result === "ok") {
    try {
      const data = await api<{ refreshToken: string | null }>("/api/youtube/oauth/result");
      if (data.refreshToken) {
        tokenField.value = data.refreshToken;
        tokenWrap.classList.remove("hidden");
        status.textContent = "Copy the token into .env as YOUTUBE_REFRESH_TOKEN, then restart.";
      } else {
        status.textContent = "Authorization succeeded but the token was already consumed. Run Authorize again.";
      }
    } catch (err: any) {
      status.textContent = err.message || "Could not read the refresh token.";
    }
    return;
  }
  tokenWrap.classList.add("hidden");
  status.textContent = reason || "YouTube authorization failed.";
}

settingsBtn.addEventListener("click", () => {
  settingsError.classList.add("hidden");
  settingsModal.classList.remove("hidden");
  loadYoutubeOauthInfo().catch(() => void 0);
});
settingsCancel.addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.add("hidden");
});

$<HTMLButtonElement>("yt-authorize-btn").addEventListener("click", () => {
  window.location.href = "/api/youtube/oauth/start";
});
$<HTMLButtonElement>("yt-copy-token").addEventListener("click", async () => {
  const value = $<HTMLTextAreaElement>("yt-refresh-token").value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    $<HTMLParagraphElement>("yt-oauth-status").textContent = "Copied. Paste it into .env, then restart.";
  } catch {
    $<HTMLTextAreaElement>("yt-refresh-token").select();
  }
});

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  settingsError.classList.add("hidden");
  const ntfy = {
    enabled: $<HTMLInputElement>("ntfy-enabled").checked,
    server: $<HTMLInputElement>("ntfy-server").value.trim(),
    topic: $<HTMLInputElement>("ntfy-topic").value.trim(),
    username: $<HTMLInputElement>("ntfy-username").value,
    password: $<HTMLInputElement>("ntfy-password").value,
    priority: parseInt($<HTMLInputElement>("ntfy-priority").value, 10) || 3,
  };
  try {
    const saved = await api<AppSettings>("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        ntfy,
        youtube: { autoUpload: ytAutoUpload.checked },
      }),
    });
    autoUploadEnabled = !!saved.youtube?.autoUpload;
    syncAutoUploadUi();
    settingsModal.classList.add("hidden");
  } catch (err: any) {
    settingsError.textContent = err.message || "Failed to save settings";
    settingsError.classList.remove("hidden");
  }
});

async function persistAutoUpload(enabled: boolean): Promise<void> {
  autoUploadEnabled = enabled;
  syncAutoUploadUi();
  try {
    const saved = await api<AppSettings>("/api/settings", {
      method: "POST",
      body: JSON.stringify({ youtube: { autoUpload: enabled } }),
    });
    autoUploadEnabled = !!saved.youtube?.autoUpload;
    syncAutoUploadUi();
  } catch (err) {
    console.error(err);
    autoUploadEnabled = !enabled;
    syncAutoUploadUi();
  }
}

autoUploadToggle.addEventListener("change", () => {
  void persistAutoUpload(autoUploadToggle.checked);
});

function loadYoutubeFormDraft(): {
  privacy: "public" | "unlisted" | "private";
  playlistId: string;
} {
  const empty = {
    privacy: "unlisted" as const,
    playlistId: "",
  };
  try {
    const raw = localStorage.getItem(YT_FORM_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    const privacy =
      parsed.privacy === "public" || parsed.privacy === "private" || parsed.privacy === "unlisted"
        ? parsed.privacy
        : "unlisted";
    return {
      privacy,
      playlistId: typeof parsed.playlistId === "string" ? parsed.playlistId : "",
    };
  } catch {
    return empty;
  }
}

function saveYoutubeFormDraft(): void {
  localStorage.setItem(
    YT_FORM_KEY,
    JSON.stringify({
      privacy: ytPrivacy.value,
      playlistId: ytPlaylist.value || "",
    })
  );
}

function jobChannelUrl(job: DownloadJob | undefined): string {
  if (!job) return "";
  if (job.channelUrl) return job.channelUrl;
  if (job.channel) return `https://www.twitch.tv/${job.channel}`;
  return "";
}

function defaultYoutubeDescription(job: DownloadJob | undefined): string {
  return `twitch channel: ${jobChannelUrl(job)}\n\nProducer:\nObserver 1:\nObserver 2:\n`;
}

function defaultYoutubeTitle(job: DownloadJob | undefined): string {
  if (!job) return "[VOD] - Twitch VOD";
  const prefix = job.vodDate ? `[VOD] ${job.vodDate} - ` : "[VOD] - ";
  return (prefix + (job.title || "Twitch VOD")).slice(0, 100);
}

function updateTitleCount(): void {
  ytTitleCount.textContent = `${ytTitle.value.length} / 100`;
}

ytTitle.addEventListener("input", updateTitleCount);

function closeYoutubeModal(): void {
  youtubeModal.classList.add("hidden");
  youtubeJobId = null;
}

async function openYoutubeModal(jobId: string): Promise<void> {
  youtubeJobId = jobId;
  youtubeError.classList.add("hidden");
  const draft = loadYoutubeFormDraft();
  let settingsDraft: YoutubeAppSettings | undefined;
  try {
    const settings = await api<AppSettings>("/api/settings");
    settingsDraft = settings.youtube;
  } catch {
    settingsDraft = undefined;
  }
  ytPrivacy.value = settingsDraft?.privacy || draft.privacy || "unlisted";
  const preferredPlaylist = settingsDraft?.playlistId || draft.playlistId || "";
  ytPlaylist.replaceChildren();
  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = "Loading playlists...";
  ytPlaylist.appendChild(loading);
  youtubeSubmit.disabled = true;

  const jobs = await api<DownloadJob[]>("/api/jobs").catch(() => [] as DownloadJob[]);
  const job = jobs.find((j) => j.id === jobId);
  ytTitle.value = defaultYoutubeTitle(job);
  ytDescription.value = defaultYoutubeDescription(job);
  updateTitleCount();
  youtubeModal.classList.remove("hidden");

  try {
    const data = await api<{ playlists: { id: string; title: string }[]; defaultTitle: string }>(
      "/api/youtube/playlists"
    );
    ytPlaylist.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No playlist";
    ytPlaylist.appendChild(none);
    const defaultTitle = (data.defaultTitle || "Observing - Valorant").toLowerCase();
    let defaultId = "";
    for (const playlist of data.playlists || []) {
      const option = document.createElement("option");
      option.value = playlist.id;
      option.textContent = playlist.title;
      ytPlaylist.appendChild(option);
      if (playlist.title.trim().toLowerCase() === defaultTitle) defaultId = playlist.id;
    }
    if (preferredPlaylist && Array.from(ytPlaylist.options).some((o) => o.value === preferredPlaylist)) {
      ytPlaylist.value = preferredPlaylist;
    } else {
      ytPlaylist.value = defaultId;
    }
    youtubeSubmit.disabled = false;
  } catch (err: any) {
    youtubeError.textContent =
      err.message ||
      "Could not load playlists. Authorize YouTube again from Settings if playlist access is missing.";
    youtubeError.classList.remove("hidden");
    youtubeSubmit.disabled = false;
  }
}

youtubeCancel.addEventListener("click", () => closeYoutubeModal());
youtubeModal.addEventListener("click", (e) => {
  if (e.target === youtubeModal) closeYoutubeModal();
});

youtubeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!youtubeJobId) return;
  saveYoutubeFormDraft();
  youtubeError.classList.add("hidden");
  youtubeSubmit.disabled = true;
  try {
    await api(`/api/jobs/${youtubeJobId}/youtube`, {
      method: "POST",
      body: JSON.stringify({
        title: ytTitle.value.trim().slice(0, 100),
        privacy: ytPrivacy.value,
        description: ytDescription.value.slice(0, 5000),
        playlistId: ytPlaylist.value || null,
      }),
    });
    closeYoutubeModal();
  } catch (err: any) {
    youtubeError.textContent = err.message || "Failed to start YouTube upload";
    youtubeError.classList.remove("hidden");
  } finally {
    youtubeSubmit.disabled = false;
  }
});

checkSession();
