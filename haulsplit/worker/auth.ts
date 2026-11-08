import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Me } from "../shared/api";
import {
  type AppEnv,
  type SessionUser,
  fail,
  first,
  hashPassword,
  newId,
  now,
  randomToken,
  run,
  sha256Hex,
  verifyPassword,
} from "./lib";

const COOKIE = "hs_session";
const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 365 * DAY;
const LOGIN_LINK_TTL_SELF = 30 * 60 * 1000;
const LOGIN_LINK_TTL_OWNER = 3 * DAY;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60 * 1000;

export function toMe(u: Pick<SessionUser, "id" | "name" | "email" | "zelle" | "password_hash">): Me {
  return { id: u.id, name: u.name, email: u.email, zelle: u.zelle, hasPassword: !!u.password_hash };
}

async function createSession(c: Context<AppEnv>, userId: string, method: "signup" | "password" | "link") {
  const token = randomToken(32);
  const t = now();
  await run(
    c.env.DB,
    "INSERT INTO sessions (token_hash, user_id, method, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    await sha256Hex(token),
    userId,
    method,
    t + SESSION_TTL,
    t,
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

/** Loads the logged-in user (if any) into c.var.user. */
export const loadUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    const row = await first<SessionUser & { expires_at: number }>(
      c.env.DB,
      `SELECT u.id, u.name, u.email, u.zelle, u.password_hash, s.method AS session_method,
              s.created_at AS session_created_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
      hash,
      now(),
    );
    if (row) {
      // Sliding expiry: keep active people logged in.
      if (row.expires_at - now() < SESSION_TTL / 2) {
        await run(c.env.DB, "UPDATE sessions SET expires_at = ? WHERE token_hash = ?", now() + SESSION_TTL, hash);
      }
      c.set("user", row);
    }
  }
  await next();
});

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) fail(401, "Please log in.");
  await next();
});

async function joinByInvite(c: Context<AppEnv>, userId: string, inviteCode: string | undefined): Promise<string | null> {
  if (!inviteCode) return null;
  const group = await first<{ id: string }>(c.env.DB, "SELECT id FROM split_groups WHERE invite_code = ?", inviteCode.toUpperCase());
  if (!group) return null;
  await run(
    c.env.DB,
    "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
    group.id,
    userId,
    now(),
  );
  return group.id;
}

export async function createLoginLink(c: Context<AppEnv>, userId: string, createdBy: string, ttl: number) {
  const token = randomToken(32);
  const expiresAt = now() + ttl;
  await run(
    c.env.DB,
    "INSERT INTO login_links (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
    await sha256Hex(token),
    userId,
    createdBy,
    expiresAt,
  );
  const origin = new URL(c.req.url).origin;
  return { url: `${origin}/l/${token}`, expiresAt };
}

export const OWNER_LINK_TTL = LOGIN_LINK_TTL_OWNER;

const name = z.string().trim().min(1, "Please enter your name.").max(60);
const email = z.string().trim().toLowerCase().email("That email doesn't look right.").max(200);
const password = z.string().min(8, "Passwords need at least 8 characters.").max(200);
const inviteCode = z.string().trim().max(32).optional();

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) fail(400, result.error.issues[0]?.message ?? "Invalid request.");
  return result.data;
}

export async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/auth/start", async (c) => {
  const input = parse(
    z
      .object({ name, email: email.optional().or(z.literal("")), password: password.optional().or(z.literal("")), inviteCode })
      .refine((v) => !v.email || v.password, { message: "Pick a password so you can log in on other devices." }),
    await body(c),
  );
  if (input.email) {
    const taken = await first(c.env.DB, "SELECT 1 FROM users WHERE email = ?", input.email);
    if (taken) fail(409, "There's already an account with that email — log in instead.");
  }
  if (input.inviteCode) {
    const group = await first(c.env.DB, "SELECT 1 FROM split_groups WHERE invite_code = ?", input.inviteCode.toUpperCase());
    if (!group) fail(404, "That invite link isn't valid anymore. Ask for a new one.");
  }
  const id = newId();
  await run(
    c.env.DB,
    "INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    input.name,
    input.email || null,
    input.email && input.password ? await hashPassword(input.password, c.env) : null,
    now(),
  );
  const groupId = await joinByInvite(c, id, input.inviteCode);
  await createSession(c, id, "signup");
  return c.json({ me: toMe({ id, name: input.name, email: input.email || null, zelle: null, password_hash: input.password ? "x" : null }), groupId });
});

authRoutes.post("/auth/login", async (c) => {
  const input = parse(z.object({ email, password: z.string().min(1).max(200), inviteCode }), await body(c));
  const key = `email:${input.email}`;
  const attempts = await first<{ failures: number; window_start: number }>(
    c.env.DB,
    "SELECT failures, window_start FROM login_attempts WHERE key = ?",
    key,
  );
  if (attempts && attempts.window_start > now() - FAILURE_WINDOW && attempts.failures >= MAX_FAILURES) {
    fail(429, "Too many tries. Wait 15 minutes, or ask your group's owner for a login link.");
  }
  const user = await first<SessionUser>(
    c.env.DB,
    "SELECT id, name, email, zelle, password_hash FROM users WHERE email = ?",
    input.email,
  );
  const ok = user?.password_hash ? await verifyPassword(input.password, user.password_hash) : false;
  if (!user || !ok) {
    const t = now();
    await run(
      c.env.DB,
      `INSERT INTO login_attempts (key, failures, window_start) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN window_start < ? THEN 1 ELSE failures + 1 END,
         window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END`,
      key,
      t,
      t - FAILURE_WINDOW,
      t - FAILURE_WINDOW,
    );
    fail(401, "Wrong email or password.");
  }
  await run(c.env.DB, "DELETE FROM login_attempts WHERE key = ?", key);
  const groupId = await joinByInvite(c, user.id, input.inviteCode);
  await createSession(c, user.id, "password");
  return c.json({ me: toMe(user), groupId });
});

authRoutes.post("/auth/link", async (c) => {
  const input = parse(z.object({ token: z.string().min(20).max(100), inviteCode }), await body(c));
  const hash = await sha256Hex(input.token);
  const link = await first<{ user_id: string; expires_at: number }>(
    c.env.DB,
    "SELECT user_id, expires_at FROM login_links WHERE token_hash = ?",
    hash,
  );
  if (!link || link.expires_at < now()) fail(410, "This login link has expired or was already used. Ask for a new one.");
  await run(c.env.DB, "DELETE FROM login_links WHERE token_hash = ?", hash);
  const user = await first<SessionUser>(c.env.DB, "SELECT id, name, email, zelle, password_hash FROM users WHERE id = ?", link.user_id);
  if (!user) fail(410, "This account no longer exists.");
  const groupId = await joinByInvite(c, user.id, input.inviteCode);
  await createSession(c, user.id, "link");
  return c.json({ me: toMe(user), groupId });
});

authRoutes.post("/auth/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await run(c.env.DB, "DELETE FROM sessions WHERE token_hash = ?", await sha256Hex(token));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/invites/:code", async (c) => {
  const group = await first<{ id: string; name: string; owner_name: string; member_count: number }>(
    c.env.DB,
    `SELECT g.id, g.name, u.name AS owner_name,
            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM split_groups g JOIN users u ON u.id = g.owner_id
      WHERE g.invite_code = ?`,
    c.req.param("code").toUpperCase(),
  );
  if (!group) fail(404, "That invite link isn't valid anymore. Ask for a new one.");
  const user = c.get("user");
  const isMember = user
    ? !!(await first(c.env.DB, "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", group.id, user.id))
    : false;
  return c.json({ group: { id: group.id, name: group.name, ownerName: group.owner_name, memberCount: group.member_count }, isMember });
});

// ---------------------------------------------------------------- me

// requireUser is applied to these in index.ts (a sub-app `use` would leak onto every /api route).
export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", (c) => c.json({ me: toMe(c.get("user")) }));

meRoutes.patch("/me", async (c) => {
  const input = parse(
    z.object({ name: name.optional(), zelle: z.string().trim().max(120).nullable().optional() }),
    await body(c),
  );
  const user = c.get("user");
  const next = { ...user, name: input.name ?? user.name, zelle: input.zelle === undefined ? user.zelle : input.zelle || null };
  await run(c.env.DB, "UPDATE users SET name = ?, zelle = ? WHERE id = ?", next.name, next.zelle, user.id);
  return c.json({ me: toMe(next) });
});

meRoutes.put("/me/credentials", async (c) => {
  const input = parse(z.object({ email, password, currentPassword: z.string().max(200).optional() }), await body(c));
  const user = c.get("user");
  // Changing an existing password needs the old one, unless you just came in through a login link
  // (that's how forgotten passwords get reset).
  const viaFreshLink = user.session_method === "link" && now() - user.session_created_at < 60 * 60 * 1000;
  if (user.password_hash && !viaFreshLink) {
    const ok = input.currentPassword ? await verifyPassword(input.currentPassword, user.password_hash) : false;
    if (!ok) fail(403, "Your current password is wrong.");
  }
  const taken = await first(c.env.DB, "SELECT 1 FROM users WHERE email = ? AND id <> ?", input.email, user.id);
  if (taken) fail(409, "Another account already uses that email.");
  const hash = await hashPassword(input.password, c.env);
  await run(c.env.DB, "UPDATE users SET email = ?, password_hash = ? WHERE id = ?", input.email, hash, user.id);
  return c.json({ me: toMe({ ...user, email: input.email, password_hash: hash }) });
});

meRoutes.post("/me/login-link", async (c) => {
  const user = c.get("user");
  return c.json(await createLoginLink(c, user.id, user.id, LOGIN_LINK_TTL_SELF));
});
