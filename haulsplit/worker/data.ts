import type { Context } from "hono";
import type { HaulStatus, HaulSummary, Item, Settlement } from "../shared/api";
import { computeTotals, type SplitItem } from "../shared/split";
import { isUnit } from "../shared/units";
import { type AppEnv, all, fail, first, placeholders } from "./lib";

export interface GroupRow {
  id: string;
  name: string;
  invite_code: string;
  owner_id: string;
}

export interface HaulRow {
  id: string;
  group_id: string;
  group_name: string;
  owner_id: string;
  organizer_id: string;
  organizer_name: string;
  organizer_zelle: string | null;
  title: string;
  store: string | null;
  purchased_on: string | null;
  pickup: string | null;
  tax_rate: number;
  status: HaulStatus;
  created_at: number;
  updated_at: number;
}

export interface ItemRow {
  id: string;
  haul_id: string;
  name: string;
  item_number: string | null;
  barcode: string | null;
  price_cents: number;
  quantity: number;
  unit: string;
  shares: number;
  taxable: number;
  expires_on: string | null;
  notes: string | null;
  position: number;
}

interface ClaimRow {
  item_id: string;
  user_id: string;
  shares: number;
}

interface SettlementRow {
  haul_id: string;
  user_id: string;
  confirmed_at: number | null;
  paid_cents: number;
  paid_at: number | null;
  verified_cents: number;
  verified_at: number | null;
}

const HAUL_SELECT = `
  SELECT h.*, g.name AS group_name, g.owner_id, o.name AS organizer_name, o.zelle AS organizer_zelle
    FROM hauls h
    JOIN split_groups g ON g.id = h.group_id
    JOIN users o ON o.id = h.organizer_id`;

export async function requireMember(c: Context<AppEnv>, groupId: string): Promise<GroupRow> {
  const user = c.get("user");
  const group = await first<GroupRow>(
    c.env.DB,
    `SELECT g.id, g.name, g.invite_code, g.owner_id FROM split_groups g
       JOIN group_members m ON m.group_id = g.id AND m.user_id = ?
      WHERE g.id = ?`,
    user.id,
    groupId,
  );
  if (!group) fail(404, "Group not found.");
  return group;
}

/** Loads a haul the current user is allowed to see. Drafts are only visible to their organizer. */
export async function requireHaul(c: Context<AppEnv>, haulId: string): Promise<HaulRow> {
  const user = c.get("user");
  const haul = await first<HaulRow>(
    c.env.DB,
    `${HAUL_SELECT}
       JOIN group_members m ON m.group_id = h.group_id AND m.user_id = ?
      WHERE h.id = ?`,
    user.id,
    haulId,
  );
  if (!haul || (haul.status === "draft" && haul.organizer_id !== user.id)) fail(404, "Haul not found.");
  return haul;
}

export function requireOrganizer(c: Context<AppEnv>, haul: HaulRow) {
  if (haul.organizer_id !== c.get("user").id) fail(403, "Only the organizer can do that.");
}

export function toItem(row: ItemRow, claims: ClaimRow[]): Item {
  return {
    id: row.id,
    name: row.name,
    itemNumber: row.item_number,
    barcode: row.barcode,
    priceCents: row.price_cents,
    quantity: row.quantity,
    unit: isUnit(row.unit) ? row.unit : "item",
    shares: row.shares,
    taxable: !!row.taxable,
    expiresOn: row.expires_on,
    notes: row.notes,
    position: row.position,
    claims: claims.filter((c) => c.item_id === row.id).map((c) => ({ userId: c.user_id, shares: c.shares })),
  };
}

export function toSettlement(row: SettlementRow): Settlement {
  return {
    userId: row.user_id,
    confirmedAt: row.confirmed_at,
    paidCents: row.paid_cents,
    paidAt: row.paid_at,
    verifiedCents: row.verified_cents,
    verifiedAt: row.verified_at,
  };
}

export async function loadItems(db: D1Database, haulId: string): Promise<Item[]> {
  const [items, claims] = await Promise.all([
    all<ItemRow>(db, "SELECT * FROM items WHERE haul_id = ? ORDER BY position, created_at", haulId),
    all<ClaimRow>(
      db,
      `SELECT c.item_id, c.user_id, c.shares FROM claims c JOIN items i ON i.id = c.item_id
        WHERE i.haul_id = ? ORDER BY c.updated_at`,
      haulId,
    ),
  ]);
  return items.map((row) => toItem(row, claims));
}

export function asSplitItems(items: Item[]): SplitItem[] {
  return items.map((i) => ({ id: i.id, priceCents: i.priceCents, shares: i.shares, taxable: i.taxable, claims: i.claims }));
}

/** A person's current total for a haul, computed the same way the app shows it. */
export async function totalFor(db: D1Database, haul: HaulRow, userId: string): Promise<number> {
  const items = await loadItems(db, haul.id);
  return computeTotals(asSplitItems(items), haul.tax_rate).people[userId]?.totalCents ?? 0;
}

export async function listHauls(db: D1Database, userId: string, where: string, ...params: (string | number)[]): Promise<HaulRow[]> {
  return all<HaulRow>(
    db,
    `${HAUL_SELECT}
       JOIN group_members m ON m.group_id = h.group_id AND m.user_id = ?
      WHERE (h.status <> 'draft' OR h.organizer_id = ?) AND ${where}
      ORDER BY COALESCE(h.purchased_on, '') DESC, h.created_at DESC
      LIMIT 50`,
    userId,
    userId,
    ...params,
  );
}

export async function summarizeHauls(db: D1Database, userId: string, hauls: HaulRow[]): Promise<HaulSummary[]> {
  if (hauls.length === 0) return [];
  const ids = hauls.map((h) => h.id);
  const ph = placeholders(ids.length);
  const [items, claims, settlements] = await Promise.all([
    all<ItemRow>(db, `SELECT * FROM items WHERE haul_id IN (${ph})`, ...ids),
    all<ClaimRow & { haul_id: string }>(
      db,
      `SELECT c.item_id, c.user_id, c.shares, i.haul_id FROM claims c JOIN items i ON i.id = c.item_id WHERE i.haul_id IN (${ph})`,
      ...ids,
    ),
    all<SettlementRow>(db, `SELECT * FROM settlements WHERE haul_id IN (${ph})`, ...ids),
  ]);

  return hauls.map((h) => {
    const haulItems = items.filter((i) => i.haul_id === h.id).map((row) => toItem(row, claims));
    const totals = computeTotals(asSplitItems(haulItems), h.tax_rate);
    const mine = settlements.find((s) => s.haul_id === h.id && s.user_id === userId);
    const isOrganizer = h.organizer_id === userId;
    let outstanding = 0;
    if (isOrganizer) {
      for (const person of Object.values(totals.people)) {
        if (person.userId === userId) continue;
        const s = settlements.find((x) => x.haul_id === h.id && x.user_id === person.userId);
        outstanding += Math.max(0, person.totalCents - (s?.verified_cents ?? 0));
      }
    }
    const relevant = haulItems.filter((i) => (isOrganizer ? true : i.claims.some((c) => c.userId === userId)));
    const expiries = relevant.map((i) => i.expiresOn).filter((d): d is string => !!d).sort();
    return {
      id: h.id,
      groupId: h.group_id,
      groupName: h.group_name,
      title: h.title,
      store: h.store,
      purchasedOn: h.purchased_on,
      status: h.status,
      organizerId: h.organizer_id,
      organizerName: h.organizer_name,
      isOrganizer,
      itemCount: haulItems.length,
      haulCents: totals.haulCents,
      myTotalCents: isOrganizer
        ? (totals.people[userId]?.totalCents ?? 0) + totals.unclaimedCents
        : (totals.people[userId]?.totalCents ?? 0),
      myPaidCents: mine?.paid_cents ?? 0,
      myVerifiedCents: mine?.verified_cents ?? 0,
      myConfirmed: !!mine?.confirmed_at,
      outstandingCents: outstanding,
      nextExpiry: expiries[0] ?? null,
      createdAt: h.created_at,
    };
  });
}
