const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CLIENT_ID = (process.env.YOUTUBE_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.YOUTUBE_CLIENT_SECRET || "").trim();
const REDIRECT_URI = "http://localhost";
const SCOPE = "https://www.googleapis.com/auth/youtube";

function authUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function extractCode(raw) {
  const value = (raw || "").trim();
  if (!value) return "";
  try {
    if (value.includes("://") || value.includes("code=")) {
      const url = value.startsWith("http") ? new URL(value) : new URL(`http://localhost/?${value.replace(/^\?/, "")}`);
      return url.searchParams.get("code") || "";
    }
  } catch {
    /* fall through */
  }
  return value;
}

async function exchangeCode(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    const detail = data.error_description || data.error || JSON.stringify(data);
    throw new Error(detail);
  }
  return data.refresh_token;
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first.");
    process.exit(1);
  }

  const rawArg = process.argv.slice(2).join(" ").trim();
  if (!rawArg) {
    console.log("1. Open this URL, sign in with the YouTube channel Google account:\n");
    console.log(authUrl());
    console.log("\n2. Google redirects to http://localhost/?code=... (the page can fail to load).");
    console.log("   Copy the whole address bar, then run:\n");
    console.log('   npm run youtube:oauth -- "PASTE_THE_URL_OR_CODE_HERE"\n');
    return;
  }

  const code = extractCode(rawArg);
  if (!code) {
    console.error("Could not find an OAuth code in that input.");
    process.exit(1);
  }

  try {
    const refreshToken = await exchangeCode(code);
    console.log("\nYOUTUBE_REFRESH_TOKEN=" + refreshToken);
    console.log("\nPaste that into .env, then restart the app.");
  } catch (err) {
    console.error("Failed to exchange code:", err.message);
    console.error("Codes expire quickly. Run npm run youtube:oauth again and open a fresh URL.");
    process.exit(1);
  }
}

main();
