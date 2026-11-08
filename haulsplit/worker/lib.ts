import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Secret. Enables photo receipt scanning with Claude. */
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  /** Override for tests; PBKDF2 rounds for new password hashes. */
  PASSWORD_ITERATIONS?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  zelle: string | null;
  password_hash: string | null;
  session_method: string;
  session_created_at: number;
}

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

export function fail(status: ContentfulStatusCode, message: string): never {
  throw new HTTPException(status, { message });
}

export function now(): number {
  return Date.now();
}

// ---------------------------------------------------------------- ids & tokens

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newId(): string {
  return randomToken(12);
}

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I

export function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % 32]).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- passwords

const DEFAULT_ITERATIONS = 100_000; // the maximum Workers' WebCrypto allows

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function unb64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export async function hashPassword(password: string, env: Env): Promise<string> {
  const iterations = Number(env.PASSWORD_ITERATIONS) || DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, expected] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !iter || !salt || !expected) return false;
  const actual = await pbkdf2(password, unb64(salt), Number(iter));
  const want = unb64(expected);
  if (actual.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ want[i];
  return diff === 0;
}

// ---------------------------------------------------------------- D1 helpers

type Param = string | number | null | undefined | boolean;

function bind(db: D1Database, sql: string, params: Param[]) {
  return db.prepare(sql).bind(...params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p)));
}

export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return bind(db, sql, params);
}

export async function first<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  return bind(db, sql, params).first<T>();
}

export async function all<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  const res = await bind(db, sql, params).all<T>();
  return res.results;
}

export async function run(db: D1Database, sql: string, ...params: Param[]): Promise<D1Result> {
  return bind(db, sql, params).run();
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}
