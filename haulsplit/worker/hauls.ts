import { Hono } from "hono";
import { z } from "zod";
import type { HaulDetail, ItemInput, ReceiptResult } from "../shared/api";
import { parseReceiptText } from "../shared/receipt";
import { UNIT_IDS, type Unit } from "../shared/units";
import { body, parse } from "./auth";
import {
  type ItemRow,
  loadItems,
  requireHaul,
  requireMember,
  requireOrganizer,
  toItem,
  toSettlement,
  totalFor,
} from "./data";
import { type AppEnv, all, fail, first, newId, now, run, stmt } from "./lib";
import { lookupProduct, normalizeCode, rememberProducts } from "./products";
import { ReceiptAIError, parseReceiptImages, type ReceiptImage } from "./receipt-ai";

export const haulRoutes = new Hono<AppEnv>();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-07.");
const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

const haulFields = z.object({
  title: z.string().trim().min(1, "Give the haul a name.").max(80),
  store: optionalText(80),
  purchasedOn: date.nullish(),
  pickup: optionalText(300),
  taxRate: z.number().min(0).max(30).optional(),
});

const itemFields = z.object({
  name: z.string().trim().min(1, "Every item needs a name.").max(120),
  itemNumber: optionalText(20),
  barcode: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,32}$/, "That barcode doesn't look right.")
    .nullish()
    .transform((v) => (v ? normalizeCode(v) : null)),
  priceCents: z.number().int().min(0).max(1_000_000),
  quantity: z.number().positive("Quantity must be more than 0.").max(100_000),
  unit: z.enum(UNIT_IDS as [Unit, ...Unit[]]),
  shares: z.number().int().min(1, "Split into at least 1 portion.").max(500, "That's a lot of portions — 500 max."),
  taxable: z.boolean(),
  expiresOn: date.nullish().transform((v) => v || null),
  notes: optionalText(300),
});

// ---------------------------------------------------------------- hauls

haulRoutes.post("/groups/:id/hauls", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  const input = parse(haulFields, await body(c));
  const id = newId();
  const t = now();
  await run(
    c.env.DB,
    `INSERT INTO hauls (id, group_id, organizer_id, title, store, purchased_on, pickup, tax_rate, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    id,
    group.id,
    c.get("user").id,
    input.title,
    input.store,
    input.purchasedOn ?? null,
    input.pickup,
    input.taxRate ?? 0,
    t,
    t,
  );
  return c.json({ id });
});

haulRoutes.get("/hauls/:id", async (c) => {
  const haul = await requireHaul(c, c.req.param("id"));
  const user = c.get("user");
  const [items, settlements, members] = await Promise.all([
    loadItems(c.env.DB, haul.id),
    all<Parameters<typeof toSettlement>[0]>(c.env.DB, "SELECT * FROM settlements WHERE haul_id = ?", haul.id),
    all<{ id: string; name: string }>(
      c.env.DB,
      `SELECT u.id, u.name FROM users u WHERE u.id IN (
         SELECT user_id FROM group_members WHERE group_id = ?
         UNION SELECT c.user_id FROM claims c JOIN items i ON i.id = c.item_id WHERE i.haul_id = ?
         UNION SELECT user_id FROM settlements WHERE haul_id = ?
       ) ORDER BY u.name COLLATE NOCASE`,
      haul.group_id,
      haul.id,
      haul.id,
    ),
  ]);
  const data: HaulDetail = {
    haul: {
      id: haul.id,
      groupId: haul.group_id,
      groupName: haul.group_name,
      title: haul.title,
      store: haul.store,
      purchasedOn: haul.purchased_on,
      pickup: haul.pickup,
      taxRate: haul.tax_rate,
      status: haul.status,
      organizer: { id: haul.organizer_id, name: haul.organizer_name, zelle: haul.organizer_zelle },
      createdAt: haul.created_at,
      updatedAt: haul.updated_at,
    },
    meId: user.id,
    isOrganizer: haul.organizer_id === user.id,
    members,
    items,
    settlements: settlements.map(toSettlement),
  };
  return c.json(data);
});

haulRoutes.patch("/hauls/:id", async (c) => {
  const haul = await requireHaul(c, c.req.param("id"));
  requireOrganizer(c, haul);
  const input = parse(haulFields.partial().extend({ status: z.enum(["draft", "open", "closed"]).optional() }), await body(c));
  await run(
    c.env.DB,
    `UPDATE hauls SET title = ?, store = ?, purchased_on = ?, pickup = ?, tax_rate = ?, status = ?, updated_at = ? WHERE id = ?`,
    input.title ?? haul.title,
    input.store === undefined ? haul.store : input.store,
    input.purchasedOn === undefined ? haul.purchased_on : input.purchasedOn,
    input.pickup === undefined ? haul.pickup : input.pickup,
    input.taxRate ?? haul.tax_rate,
    input.status ?? haul.status,
    now(),
    haul.id,
  );
  return c.json({ ok: true });
});

haulRoutes.delete("/hauls/:id", async (c) => {
  const haul = await requireHaul(c, c.req.param("id"));
  requireOrganizer(c, haul);
  await run(c.env.DB, "DELETE FROM hauls WHERE id = ?", haul.id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- items

function touch(haulId: string, db: D1Database) {
  return stmt(db, "UPDATE hauls SET updated_at = ? WHERE id = ?", now(), haulId);
}

haulRoutes.post("/hauls/:id/items", async (c) => {
  const haul = await requireHaul(c, c.req.param("id"));
  requireOrganizer(c, haul);
  const input = parse(z.object({ items: z.array(itemFields).min(1).max(200) }), await body(c));
  const last = await first<{ max: number | null }>(c.env.DB, "SELECT MAX(position) AS max FROM items WHERE haul_id = ?", haul.id);
  let position = (last?.max ?? -1) + 1;
  const t = now();
  const ids: string[] = [];
  const statements = input.items.map((item) => {
    const id = newId();
    ids.push(id);
    return stmt(
      c.env.DB,
      `INSERT INTO items (id, haul_id, name, item_number, barcode, price_cents, quantity, unit, shares, taxable,
                          expires_on, notes, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      haul.id,
      item.name,
      item.itemNumber,
      item.barcode,
      item.priceCents,
      item.quantity,
      item.unit,
      item.shares,
      item.taxable,
      item.expiresOn,
      item.notes,
      position++,
      t,
      t,
    );
  });
  await c.env.DB.batch([...statements, ...rememberProducts(c.env.DB, haul.group_id, input.items), touch(haul.id, c.env.DB)]);
  return c.json({ ids });
});

async function requireItem(c: Parameters<typeof requireHaul>[0], itemId: string) {
  const row = await first<ItemRow>(c.env.DB, "SELECT * FROM items WHERE id = ?", itemId);
  if (!row) fail(404, "Item not found.");
  const haul = await requireHaul(c, row.haul_id);
  return { row, haul };
}

haulRoutes.patch("/items/:id", async (c) => {
  const { row, haul } = await requireItem(c, c.req.param("id"));
  requireOrganizer(c, haul);
  const input = parse(itemFields.partial(), await body(c));
  if (input.shares !== undefined) {
    const claimed = await first<{ total: number | null }>(c.env.DB, "SELECT SUM(shares) AS total FROM claims WHERE item_id = ?", row.id);
    if ((claimed?.total ?? 0) > input.shares) {
      fail(409, `${claimed!.total} portions are already claimed — free some up before splitting into fewer.`);
    }
  }
  const next: ItemInput = {
    name: input.name ?? row.name,
    itemNumber: input.itemNumber === undefined ? row.item_number : input.itemNumber,
    barcode: input.barcode === undefined ? row.barcode : input.barcode,
    priceCents: input.priceCents ?? row.price_cents,
    quantity: input.quantity ?? row.quantity,
    unit: input.unit ?? (row.unit as Unit),
    shares: input.shares ?? row.shares,
    taxable: input.taxable ?? !!row.taxable,
    expiresOn: input.expiresOn === undefined ? row.expires_on : input.expiresOn,
    notes: input.notes === undefined ? row.notes : input.notes,
  };
  await c.env.DB.batch([
    stmt(
      c.env.DB,
      `UPDATE items SET name = ?, item_number = ?, barcode = ?, price_cents = ?, quantity = ?, unit = ?, shares = ?,
                        taxable = ?, expires_on = ?, notes = ?, updated_at = ? WHERE id = ?`,
      next.name,
      next.itemNumber,
      next.barcode,
      next.priceCents,
      next.quantity,
      next.unit,
      next.shares,
      next.taxable,
      next.expiresOn,
      next.notes,
      now(),
      row.id,
    ),
    ...rememberProducts(c.env.DB, haul.group_id, [next]),
    touch(haul.id, c.env.DB),
  ]);
  return c.json({ ok: true });
});

haulRoutes.delete("/items/:id", async (c) => {
  const { row, haul } = await requireItem(c, c.req.param("id"));
  requireOrganizer(c, haul);
  await c.env.DB.batch([stmt(c.env.DB, "DELETE FROM items WHERE id = ?", row.id), touch(haul.id, c.env.DB)]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- claims

haulRoutes.put("/items/:id/claims/:userId", async (c) => {
  const { row, haul } = await requireItem(c, c.req.param("id"));
  const me = c.get("user").id;
  const target = c.req.param("userId");
  const isOrganizer = haul.organizer_id === me;
  const { shares } = parse(z.object({ shares: z.number().int().min(0).max(500) }), await body(c));

  if (target !== me && !isOrganizer) fail(403, "Only the organizer can pick portions for other people.");
  if (!isOrganizer && haul.status !== "open") {
    fail(409, haul.status === "closed" ? "This haul is closed — ask the organizer to make changes." : "This haul isn't open yet.");
  }
  if (target !== me) {
    const member = await first(c.env.DB, "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", haul.group_id, target);
    const existing = await first(c.env.DB, "SELECT 1 FROM claims WHERE item_id = ? AND user_id = ?", row.id, target);
    if (!member && !existing) fail(404, "That person isn't in this group.");
  }

  const t = now();
  if (shares === 0) {
    await run(c.env.DB, "DELETE FROM claims WHERE item_id = ? AND user_id = ?", row.id, target);
  } else {
    // One statement, so two people grabbing the last portion at once can't both get it.
    const result = await run(
      c.env.DB,
      `INSERT INTO claims (item_id, user_id, shares, updated_at)
       SELECT ?1, ?2, ?3, ?4
        WHERE ?3 + COALESCE((SELECT SUM(shares) FROM claims WHERE item_id = ?1 AND user_id <> ?2), 0)
              <= (SELECT shares FROM items WHERE id = ?1)
       ON CONFLICT (item_id, user_id) DO UPDATE SET shares = excluded.shares, updated_at = excluded.updated_at`,
      row.id,
      target,
      shares,
      t,
    );
    if (!result.meta.changes) {
      const taken = await first<{ total: number | null }>(
        c.env.DB,
        "SELECT SUM(shares) AS total FROM claims WHERE item_id = ? AND user_id <> ?",
        row.id,
        target,
      );
      const left = row.shares - (taken?.total ?? 0);
      fail(409, left > 0 ? `Only ${left} portion${left === 1 ? "" : "s"} left.` : "Someone just took the last portion.");
    }
  }
  // Changing your own order means you're picking again; confirm it again when done.
  if (target === me && !isOrganizer) {
    await run(c.env.DB, "UPDATE settlements SET confirmed_at = NULL WHERE haul_id = ? AND user_id = ?", haul.id, me);
  }
  const claims = await all<{ item_id: string; user_id: string; shares: number }>(
    c.env.DB,
    "SELECT item_id, user_id, shares FROM claims WHERE item_id = ? ORDER BY updated_at",
    row.id,
  );
  return c.json({ item: toItem(row, claims) });
});

// ---------------------------------------------------------------- settling up

haulRoutes.put("/hauls/:id/settlements/:userId", async (c) => {
  const haul = await requireHaul(c, c.req.param("id"));
  const me = c.get("user").id;
  const target = c.req.param("userId");
  const isOrganizer = haul.organizer_id === me;
  const { action } = parse(z.object({ action: z.enum(["confirm", "unconfirm", "sent", "unsent", "received", "unreceived"]) }), await body(c));

  if (haul.status === "draft") fail(409, "This haul isn't open yet.");
  if (target === haul.organizer_id) fail(400, "The organizer doesn't owe themselves.");
  const selfActions = ["confirm", "unconfirm", "sent", "unsent"];
  if (selfActions.includes(action) && target !== me) fail(403, "Only they can do that.");
  if (!selfActions.includes(action) && !isOrganizer) fail(403, "Only the organizer can confirm payments.");

  if (action === "unconfirm" && haul.status === "closed") fail(409, "This haul is closed.");

  const total = await totalFor(c.env.DB, haul, target);
  if ((action === "sent" || action === "received") && total <= 0) fail(409, "There's nothing to pay for yet.");
  const t = now();
  await run(c.env.DB, "INSERT OR IGNORE INTO settlements (haul_id, user_id) VALUES (?, ?)", haul.id, target);
  const updates: Record<string, string> = {
    confirm: "confirmed_at = ?2",
    unconfirm: "confirmed_at = NULL",
    sent: "paid_cents = ?1, paid_at = ?2, confirmed_at = COALESCE(confirmed_at, ?2)",
    unsent: "paid_cents = verified_cents, paid_at = CASE WHEN verified_cents > 0 THEN paid_at ELSE NULL END",
    received: "paid_cents = ?1, verified_cents = ?1, verified_at = ?2, paid_at = COALESCE(paid_at, ?2), confirmed_at = COALESCE(confirmed_at, ?2)",
    unreceived: "verified_cents = 0, verified_at = NULL",
  };
  await run(c.env.DB, `UPDATE settlements SET ${updates[action]} WHERE haul_id = ?3 AND user_id = ?4`, total, t, haul.id, target);
  const row = await first<Parameters<typeof toSettlement>[0]>(
    c.env.DB,
    "SELECT * FROM settlements WHERE haul_id = ? AND user_id = ?",
    haul.id,
    target,
  );
  return c.json({ settlement: toSettlement(row!) });
});

// ---------------------------------------------------------------- receipt scanning

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

haulRoutes.post("/hauls/:id/receipt", async (c) => {
  const haul = await requireHaul(c, c.req.param("id"));
  requireOrganizer(c, haul);
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const { text } = parse(z.object({ text: z.string().min(1, "Paste the receipt text first.").max(50_000) }), await body(c));
    const parsed = parseReceiptText(text);
    const result: ReceiptResult = { source: "text", ...parsed };
    return c.json(result);
  }

  if (!c.env.ANTHROPIC_API_KEY) {
    fail(501, "Photo scanning isn't set up on this server (it needs an ANTHROPIC_API_KEY). Paste the receipt text instead.");
  }
  const form = await c.req.formData();
  const files = form.getAll("images").filter((f): f is File => typeof f !== "string");
  if (files.length === 0) fail(400, "Add at least one photo.");
  if (files.length > 6) fail(400, "Up to 6 photos at a time.");
  const images: ReceiptImage[] = [];
  for (const file of files) {
    const type = MEDIA_TYPES.find((t) => t === file.type);
    if (!type) fail(415, "Photos need to be JPEG, PNG, WebP or GIF.");
    if (file.size > 5 * 1024 * 1024) fail(413, "Each photo needs to be under 5 MB.");
    images.push({ mediaType: type, base64: Buffer.from(await file.arrayBuffer()).toString("base64") });
  }
  try {
    const result = await parseReceiptImages(images, {
      apiKey: c.env.ANTHROPIC_API_KEY,
      model: c.env.CLAUDE_MODEL,
      effort: c.env.CLAUDE_EFFORT,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof ReceiptAIError) fail(502, err.message);
    throw err;
  }
});

// ---------------------------------------------------------------- barcodes

haulRoutes.get("/groups/:id/products/:code", async (c) => {
  const group = await requireMember(c, c.req.param("id"));
  const code = c.req.param("code");
  if (!/^[0-9A-Za-z-]{4,32}$/.test(code)) fail(400, "That barcode doesn't look right.");
  return c.json(await lookupProduct(c.env.DB, group.id, code));
});

// ---------------------------------------------------------------- calendar

function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

haulRoutes.get("/hauls/:id/expirations.ics", async (c) => {
  const haul = await requireHaul(c, c.req.param("id"));
  const me = c.get("user").id;
  const isOrganizer = haul.organizer_id === me;
  const items = await loadItems(c.env.DB, haul.id);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const events: string[] = [];
  for (const item of items) {
    if (!item.expiresOn) continue;
    const mine = item.claims.find((cl) => cl.userId === me)?.shares ?? 0;
    const leftover = item.shares - item.claims.reduce((s, cl) => s + cl.shares, 0);
    const portions = mine + (isOrganizer ? leftover : 0);
    if (portions <= 0) continue;
    const day = item.expiresOn.replace(/-/g, "");
    const next = new Date(`${item.expiresOn}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const end = next.toISOString().slice(0, 10).replace(/-/g, "");
    events.push(
      [
        "BEGIN:VEVENT",
        `UID:${item.id}-${me}@haulsplit`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${day}`,
        `DTEND;VALUE=DATE:${end}`,
        `SUMMARY:${icsEscape(`Use or freeze: ${item.name}`)}`,
        `DESCRIPTION:${icsEscape(`${portions} portion${portions === 1 ? "" : "s"} from ${haul.title}`)}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${icsEscape(`${item.name} expires tomorrow`)}`,
        "TRIGGER:-PT15H",
        "END:VALARM",
        "END:VEVENT",
      ].join("\r\n"),
    );
  }
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HaulSplit//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR", ""].join("\r\n");
  return c.body(body, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `attachment; filename="haul-expirations.ics"`,
  });
});
