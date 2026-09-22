import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
    username?: string;
    youtubeOAuthState?: string;
    youtubeOAuthRedirectUri?: string;
    youtubeRefreshTokenPreview?: string;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  // Pad to equal length first so timingSafeEqual doesn't throw on length mismatch;
  // the length check itself is not the secret here, only content is.
  const maxLen = Math.max(aBuf.length, bBuf.length, 1);
  const aPadded = Buffer.concat([aBuf], maxLen);
  const bPadded = Buffer.concat([bBuf], maxLen);
  const contentEqual = crypto.timingSafeEqual(aPadded, bPadded);
  return contentEqual && aBuf.length === bBuf.length;
}

export function checkCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.AUTH_USERNAME || "";
  const expectedPass = process.env.AUTH_PASSWORD || "";
  if (!expectedUser || !expectedPass) {
    return false;
  }
  return (
    timingSafeStringEqual(username || "", expectedUser) &&
    timingSafeStringEqual(password || "", expectedPass)
  );
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session && req.session.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: "Not authenticated" });
}
