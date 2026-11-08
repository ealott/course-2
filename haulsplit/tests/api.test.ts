/**
 * End-to-end API tests: the real worker app against a real (local, throwaway) D1 database.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { HaulDetail, HomeData } from "../shared/api";
import { computeTotals } from "../shared/split";
import app from "../worker/index";
import type { Env } from "../worker/lib";

let env: Env;
let dispose: () => Promise<void>;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "haulsplit-test-"));
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc", persist: { path: dir } });
  dispose = proxy.dispose;
  env = { ...proxy.env, PASSWORD_ITERATIONS: "1000", ANTHROPIC_API_KEY: undefined };
  const sql = readFileSync("migrations/0001_init.sql", "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const statement of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

afterAll(async () => {
  await dispose?.();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  cookie = "";
  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", "x-haulsplit": "1", cookie: this.cookie, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}

const alice = new Client();
const bob = new Client();
const grandmaPhone = new Client();
let groupId = "";
let inviteCode = "";
let haulId = "";
let chickenId = "";
let nuggetsId = "";
let towelsId = "";
let bobId = "";
let aliceId = "";

describe("HaulSplit API", () => {
  it("blocks cross-site writes", async () => {
    const res = await new Client().req("POST", "/api/auth/start", { name: "x" }, { "x-haulsplit": "" });
    expect(res.status).toBe(403);
  });

  it("requires login", async () => {
    expect((await new Client().req("GET", "/api/home")).status).toBe(401);
    expect((await new Client().req("GET", "/api/session")).data).toEqual({ me: null });
  });

  it("signs up the organizer and creates a group", async () => {
    const res = await alice.req("POST", "/api/auth/start", { name: "Alice", email: "Alice@Example.com", password: "costco-run-1" });
    expect(res.status).toBe(200);
    expect(res.data.me).toMatchObject({ name: "Alice", email: "alice@example.com", hasPassword: true });
    aliceId = res.data.me.id;
    await alice.req("PATCH", "/api/me", { zelle: "alice@example.com" });

    const group = await alice.req("POST", "/api/groups", { name: "Family" });
    groupId = group.data.id;
    const detail = await alice.req("GET", `/api/groups/${groupId}`);
    inviteCode = detail.data.group.inviteCode;
    expect(inviteCode).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("rejects a duplicate email", async () => {
    const res = await new Client().req("POST", "/api/auth/start", { name: "A2", email: "alice@example.com", password: "whatever12" });
    expect(res.status).toBe(409);
  });

  it("lets a friend join with just a name", async () => {
    const invite = await bob.req("GET", `/api/invites/${inviteCode}`);
    expect(invite.data.group).toMatchObject({ name: "Family", ownerName: "Alice", memberCount: 1 });
    const res = await bob.req("POST", "/api/auth/start", { name: "Bob", inviteCode });
    expect(res.status).toBe(200);
    expect(res.data.groupId).toBe(groupId);
    bobId = res.data.me.id;
    const home = await bob.req<HomeData>("GET", "/api/home");
    expect(home.data.groups.map((g) => g.name)).toEqual(["Family"]);
  });

  it("creates a draft haul that only the organizer can see", async () => {
    const res = await alice.req("POST", `/api/groups/${groupId}/hauls`, { title: "Costco run", purchasedOn: "2026-11-07", pickup: "My place Sat 2-5" });
    haulId = res.data.id;
    expect((await bob.req("GET", `/api/hauls/${haulId}`)).status).toBe(404);

    const items = await alice.req("POST", `/api/hauls/${haulId}/items`, {
      items: [
        { name: "Chicken breast", priceCents: 2200, quantity: 8, unit: "lb", shares: 8, taxable: false, expiresOn: "2026-11-12" },
        { name: "Chicken nuggets", priceCents: 1599, quantity: 5, unit: "lb", shares: 5, taxable: false, barcode: "096619123456" },
        { name: "Paper towels", priceCents: 1999, quantity: 12, unit: "roll", shares: 12, taxable: true },
      ],
    });
    expect(items.status).toBe(200);
    [chickenId, nuggetsId, towelsId] = items.data.ids;

    expect((await alice.req("PATCH", `/api/hauls/${haulId}`, { status: "open", taxRate: 9.25 })).status).toBe(200);
    const detail = await bob.req<HaulDetail>("GET", `/api/hauls/${haulId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.items.map((i) => i.name)).toEqual(["Chicken breast", "Chicken nuggets", "Paper towels"]);
    expect(detail.data.haul.organizer).toMatchObject({ name: "Alice", zelle: "alice@example.com" });
    expect(detail.data.isOrganizer).toBe(false);
  });

  it("enforces portions left", async () => {
    expect((await alice.req("PUT", `/api/items/${chickenId}/claims/${aliceId}`, { shares: 4 })).status).toBe(200);
    const tooMany = await bob.req("PUT", `/api/items/${chickenId}/claims/${bobId}`, { shares: 5 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.data.error).toBe("Only 4 portions left.");
    const ok = await bob.req("PUT", `/api/items/${chickenId}/claims/${bobId}`, { shares: 3 });
    expect(ok.status).toBe(200);
    expect(ok.data.item.claims).toEqual([
      { userId: aliceId, shares: 4 },
      { userId: bobId, shares: 3 },
    ]);
    // Changing your own claim is fine even when it's the max.
    expect((await bob.req("PUT", `/api/items/${chickenId}/claims/${bobId}`, { shares: 4 })).status).toBe(200);
    expect((await bob.req("PUT", `/api/items/${chickenId}/claims/${bobId}`, { shares: 3 })).status).toBe(200);
    expect((await bob.req("PUT", `/api/items/${towelsId}/claims/${bobId}`, { shares: 6 })).status).toBe(200);
  });

  it("only lets the organizer pick for others", async () => {
    expect((await bob.req("PUT", `/api/items/${nuggetsId}/claims/${aliceId}`, { shares: 1 })).status).toBe(403);
    expect((await bob.req("PATCH", `/api/items/${nuggetsId}`, { priceCents: 1 })).status).toBe(403);
  });

  it("won't split an item into fewer portions than are claimed", async () => {
    const res = await alice.req("PATCH", `/api/items/${chickenId}`, { shares: 6 });
    expect(res.status).toBe(409);
  });

  it("settles up: confirm, send, receive, then adjust", async () => {
    const detail = await bob.req<HaulDetail>("GET", `/api/hauls/${haulId}`);
    const totals = computeTotals(detail.data.items, detail.data.haul.taxRate);
    // 3 lb chicken = 3 x $2.75 = $8.25; half the towels = 19.99 * 1.0925 / 2 = $10.92
    expect(totals.people[bobId].totalCents).toBe(825 + 1092);

    const confirm = await bob.req("PUT", `/api/hauls/${haulId}/settlements/${bobId}`, { action: "confirm" });
    expect(confirm.data.settlement.confirmedAt).toBeGreaterThan(0);
    const sent = await bob.req("PUT", `/api/hauls/${haulId}/settlements/${bobId}`, { action: "sent" });
    expect(sent.data.settlement.paidCents).toBe(1917);

    let home = await alice.req<HomeData>("GET", "/api/home");
    expect(home.data.hauls[0]).toMatchObject({ isOrganizer: true, outstandingCents: 1917 });
    expect((await bob.req("PUT", `/api/hauls/${haulId}/settlements/${bobId}`, { action: "received" })).status).toBe(403);
    const received = await alice.req("PUT", `/api/hauls/${haulId}/settlements/${bobId}`, { action: "received" });
    expect(received.data.settlement.verifiedCents).toBe(1917);
    home = await alice.req<HomeData>("GET", "/api/home");
    expect(home.data.hauls[0].outstandingCents).toBe(0);

    // Bob grabs one more pound: now he owes the difference and has to confirm again.
    await bob.req("PUT", `/api/items/${chickenId}/claims/${bobId}`, { shares: 4 });
    const bobHome = await bob.req<HomeData>("GET", "/api/home");
    expect(bobHome.data.hauls[0]).toMatchObject({ myTotalCents: 2192, myPaidCents: 1917, myConfirmed: false });
  });

  it("supports people without a login, and owner-made login links", async () => {
    const grandma = await alice.req("POST", `/api/groups/${groupId}/members`, { name: "Grandma" });
    expect((await alice.req("PUT", `/api/items/${nuggetsId}/claims/${grandma.data.id}`, { shares: 2 })).status).toBe(200);

    expect((await bob.req("POST", `/api/groups/${groupId}/members/${grandma.data.id}/login-link`)).status).toBe(403);
    const link = await alice.req("POST", `/api/groups/${groupId}/members/${grandma.data.id}/login-link`);
    expect(link.data.url).toMatch(/^http:\/\/localhost\/l\//);
    const token = link.data.url.split("/l/")[1];

    const used = await grandmaPhone.req("POST", "/api/auth/link", { token });
    expect(used.data.me.name).toBe("Grandma");
    expect((await grandmaPhone.req("GET", "/api/me")).data.me.name).toBe("Grandma");
    // One-time use.
    expect((await new Client().req("POST", "/api/auth/link", { token })).status).toBe(410);
    // Owners can't take over accounts that have a password.
    expect((await alice.req("POST", `/api/groups/${groupId}/members/${aliceId}/login-link`)).status).toBe(403);
  });

  it("lets a link-logged-in user set a password without the old one", async () => {
    const res = await grandmaPhone.req("PUT", "/api/me/credentials", { email: "grandma@example.com", password: "knitting-123" });
    expect(res.status).toBe(200);
    expect(res.data.me.hasPassword).toBe(true);
    const login = await new Client().req("POST", "/api/auth/login", { email: "grandma@example.com", password: "knitting-123" });
    expect(login.status).toBe(200);
  });

  it("rate limits password guessing", async () => {
    const guesser = new Client();
    for (let i = 0; i < 10; i++) {
      expect((await guesser.req("POST", "/api/auth/login", { email: "alice@example.com", password: `nope-${i}` })).status).toBe(401);
    }
    expect((await guesser.req("POST", "/api/auth/login", { email: "alice@example.com", password: "costco-run-1" })).status).toBe(429);
  });

  it("locks claims when the haul is closed", async () => {
    await alice.req("PATCH", `/api/hauls/${haulId}`, { status: "closed" });
    const res = await bob.req("PUT", `/api/items/${towelsId}/claims/${bobId}`, { shares: 1 });
    expect(res.status).toBe(409);
    // The organizer can still fix things up.
    expect((await alice.req("PUT", `/api/items/${towelsId}/claims/${bobId}`, { shares: 5 })).status).toBe(200);
    await alice.req("PATCH", `/api/hauls/${haulId}`, { status: "open" });
  });

  it("parses pasted receipt text", async () => {
    const res = await alice.req("POST", `/api/hauls/${haulId}/receipt`, {
      text: "E 1234567 KS CHKN BRST 21.99 N\n987654 KS PAPER TOWEL 12RL 23.99 Y\n345234 /987654 4.00-\nSUBTOTAL 41.98\nTAX 1.85\n**** TOTAL 43.83",
    });
    expect(res.status).toBe(200);
    expect(res.data.source).toBe("text");
    expect(res.data.items).toHaveLength(2);
    expect(res.data.items[1]).toMatchObject({ priceCents: 1999, taxable: true, unit: "roll", quantity: 12 });
    expect(res.data.taxCents).toBe(185);
  });

  it("explains photo scanning needs an API key", async () => {
    const res = await alice.req("POST", `/api/hauls/${haulId}/receipt`, undefined, { "content-type": "multipart/form-data; boundary=x" });
    expect(res.status).toBe(501);
    expect((await alice.req("GET", "/api/config")).data).toEqual({ aiReceipts: false });
  });

  it("remembers scanned barcodes for the group", async () => {
    const res = await alice.req("GET", `/api/groups/${groupId}/products/096619123456`);
    expect(res.data).toMatchObject({
      code: "0096619123456",
      source: "group",
      product: { name: "Chicken nuggets", quantity: 5, unit: "lb", shares: 5, priceCents: 1599 },
    });
  });

  it("exports expiration dates to a calendar file", async () => {
    const res = await bob.req("GET", `/api/hauls/${haulId}/expirations.ics`);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.data).toContain("DTSTART;VALUE=DATE:20261112");
    expect(res.data).toContain("SUMMARY:Use or freeze: Chicken breast");
    expect(res.data).toContain("4 portions from Costco run");
  });

  it("logs out", async () => {
    await bob.req("POST", "/api/auth/logout");
    expect((await bob.req("GET", "/api/home")).status).toBe(401);
  });
});
