import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getPrismaClient } from "./agent/prisma.ts";

const SESSION_COOKIE = "stud_session";
const ONE_HOUR_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * ONE_HOUR_MS;
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

export type CurrentUser = {
  id: string | null;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  anonymous: boolean;
};

const hasDatabase = () => Boolean(process.env.DATABASE_URL);
export const allowAnonymousAuth = () => process.env.STUD_ALLOW_ANONYMOUS === "true";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const safeEqual = (actual: string, expected: string) => {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const isLocalHost = (host?: string) => {
  const hostname = (host ?? "").split(":")[0];
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
};

const isLocalOrigin = (origin?: string, host?: string) => {
  if (!origin) return isLocalHost(host);
  try {
    const url = new URL(origin);
    return isLocalHost(url.hostname);
  } catch {
    return false;
  }
};

const cookieOptions = () => {
  const secure = process.env.STUD_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  return [
    "HttpOnly",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
};

const clearCookieOptions = () => {
  const secure = process.env.STUD_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  return [
    "HttpOnly",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
};

export const randomToken = () => randomBytes(32).toString("base64url");

export const cookieToken = (req: Request) => {
  const raw = req.header("cookie") ?? "";
  const cookies = raw.split(";").map((part) => part.trim()).filter(Boolean);
  for (const cookie of cookies) {
    const eq = cookie.indexOf("=");
    if (eq === -1) continue;
    const name = decodeURIComponent(cookie.slice(0, eq));
    if (name === SESSION_COOKIE) return decodeURIComponent(cookie.slice(eq + 1));
  }
  return "";
};

export const publicUser = (user: CurrentUser) => ({
  id: user.id,
  email: user.email ?? null,
  displayName: user.displayName ?? null,
  avatarUrl: user.avatarUrl ?? null,
  anonymous: user.anonymous,
});

export async function resolveCurrentUser(req: Request): Promise<CurrentUser | null> {
  const token = cookieToken(req);
  if (token && hasDatabase()) {
    const tokenHash = hashToken(token);
    const session = await getPrismaClient().authSession.findFirst({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (session?.user) {
      await getPrismaClient().appUser.update({
        where: { id: session.user.id },
        data: { lastSeenAt: new Date() },
      }).catch(() => undefined);
      return {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
        avatarUrl: session.user.avatarUrl,
        anonymous: session.user.anonymous,
      };
    }
  }

  if (allowAnonymousAuth() && process.env.NODE_ENV !== "production" && isLocalOrigin(req.header("origin"), req.header("host"))) {
    return { id: null, anonymous: true };
  }
  return null;
}

export function requireCurrentUser() {
  return async (req: Request & { currentUser?: CurrentUser }, res: Response, next: NextFunction) => {
    const user = await resolveCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.currentUser = user;
    next();
  };
}

async function createSession(userId: string, res: Response) {
  const token = randomToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getPrismaClient().authSession.create({
    data: { userId, tokenHash, expiresAt },
  });
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions()}`);
}

async function upsertUser(input: {
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  anonymous?: boolean;
}) {
  const email = input.email.toLowerCase();
  return getPrismaClient().appUser.upsert({
    where: { email },
    update: {
      displayName: input.displayName ?? undefined,
      avatarUrl: input.avatarUrl ?? undefined,
      anonymous: input.anonymous ?? false,
      lastSeenAt: new Date(),
    },
    create: {
      email,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      anonymous: input.anonymous ?? false,
      settings: { create: {} },
    },
  });
}

async function verifyGoogleIdToken(idToken: string) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) throw new Error("Invalid Google credential");
  const data = await response.json() as {
    aud?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
    picture?: string;
  };
  if (process.env.GOOGLE_CLIENT_ID && data.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error("Google credential audience mismatch");
  }
  if (!data.email || data.email_verified === false || data.email_verified === "false") {
    throw new Error("Google email is not verified");
  }
  return { email: data.email, displayName: data.name ?? null, avatarUrl: data.picture ?? null };
}

async function exchangeGoogleCode(code: string, redirectUri: string) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured");
  }
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Google OAuth code exchange failed");
  const data = await response.json() as { id_token?: string };
  if (!data.id_token) throw new Error("Google OAuth did not return an id token");
  return verifyGoogleIdToken(data.id_token);
}

export async function startLogin(req: Request, res: Response) {
  if (!hasDatabase()) {
    res.status(503).json({ error: "DATABASE_URL is required for login" });
    return;
  }
  const provider = String(req.body?.provider ?? "email");
  if (provider === "google") {
    const state = randomToken();
    await getPrismaClient().loginToken.create({
      data: {
        tokenHash: hashToken(state),
        provider: "google",
        expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
      },
    });
    const redirectUri = String(req.body?.redirectUri ?? process.env.GOOGLE_REDIRECT_URI ?? "");
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    res.json({
      ok: true,
      provider: "google",
      state,
      authUrl: process.env.GOOGLE_CLIENT_ID && redirectUri
        ? `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
        : null,
    });
    return;
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }
  const token = randomToken();
  await getPrismaClient().loginToken.create({
    data: {
      email,
      provider: "email",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
    },
  });
  const echoToken = allowAnonymousAuth() || process.env.STUD_LOGIN_TOKEN_ECHO === "true";
  res.json({ ok: true, provider: "email", ...(echoToken ? { loginToken: token } : {}) });
}

export async function verifyLogin(req: Request, res: Response) {
  if (!hasDatabase()) {
    res.status(503).json({ error: "DATABASE_URL is required for login" });
    return;
  }
  const provider = String(req.body?.provider ?? "email");
  let profile: { email: string; displayName?: string | null; avatarUrl?: string | null };

  if (provider === "google") {
    const state = String(req.body?.state ?? "");
    if (state) {
      const found = await getPrismaClient().loginToken.findFirst({
        where: { tokenHash: hashToken(state), provider: "google", consumedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!found) {
        res.status(401).json({ error: "Invalid or expired Google login state" });
        return;
      }
      await getPrismaClient().loginToken.update({ where: { id: found.id }, data: { consumedAt: new Date() } });
    }
    try {
      if (typeof req.body?.credential === "string") {
        profile = await verifyGoogleIdToken(req.body.credential);
      } else if (typeof req.body?.code === "string") {
        profile = await exchangeGoogleCode(req.body.code, String(req.body?.redirectUri ?? process.env.GOOGLE_REDIRECT_URI ?? ""));
      } else {
        res.status(400).json({ error: "Google credential or code is required" });
        return;
      }
    } catch (error) {
      res.status(401).json({ error: error instanceof Error ? error.message : "Google login failed" });
      return;
    }
  } else {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const token = String(req.body?.token ?? "");
    const found = await getPrismaClient().loginToken.findFirst({
      where: { email, provider: "email", consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!found || !safeEqual(hashToken(token), found.tokenHash)) {
      res.status(401).json({ error: "Invalid or expired login token" });
      return;
    }
    await getPrismaClient().loginToken.update({ where: { id: found.id }, data: { consumedAt: new Date() } });
    profile = { email };
  }

  const user = await upsertUser(profile);
  await createSession(user.id, res);
  res.json({ user: publicUser({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    anonymous: user.anonymous,
  }) });
}

export async function logout(req: Request, res: Response) {
  const token = cookieToken(req);
  if (token && hasDatabase()) {
    await getPrismaClient().authSession.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${clearCookieOptions()}`);
  res.json({ ok: true });
}
