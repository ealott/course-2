/** Barcode lookups: the group's own memory first, then free public product databases. */
import type { ItemInput, ProductLookup } from "../shared/api";
import { defaultShares, isUnit, parseQuantityString } from "../shared/units";
import { first, now, stmt } from "./lib";

const UA = "HaulSplit/0.1 (bulk-buy splitting app)";

/** UPC-A (12 digits) and EAN-13 with a leading 0 are the same product; store them one way. */
export function normalizeCode(code: string): string {
  const trimmed = code.trim();
  if (/^\d{12}$/.test(trimmed)) return `0${trimmed}`;
  return trimmed.toUpperCase();
}

interface ProductRow {
  name: string;
  quantity: number | null;
  unit: string | null;
  shares: number | null;
  price_cents: number | null;
  taxable: number | null;
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<any | null> {
  try {
    const res = await fetcher(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function fromPublic(name: string, quantityText: string | null | undefined): NonNullable<ProductLookup["product"]> {
  const q = parseQuantityString(quantityText) ?? parseQuantityString(name);
  return {
    name,
    quantity: q?.quantity ?? null,
    unit: q?.unit ?? null,
    shares: q ? defaultShares(q.quantity, q.unit) : null,
    priceCents: null,
    taxable: null,
  };
}

export async function lookupProduct(
  db: D1Database,
  groupId: string,
  rawCode: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductLookup> {
  const code = normalizeCode(rawCode);
  const saved = await first<ProductRow>(db, "SELECT * FROM products WHERE group_id = ? AND code = ?", groupId, code);
  if (saved) {
    return {
      code,
      source: "group",
      product: {
        name: saved.name,
        quantity: saved.quantity,
        unit: isUnit(saved.unit) ? saved.unit : null,
        shares: saved.shares,
        priceCents: saved.price_cents,
        taxable: saved.taxable === null ? null : !!saved.taxable,
      },
    };
  }

  if (/^\d{8,14}$/.test(code)) {
    const off = await fetchJson(
      `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,quantity`,
      fetcher,
    );
    const p = off?.status === 1 ? off.product : null;
    if (p?.product_name) {
      const brand = typeof p.brands === "string" ? p.brands.split(",")[0].trim() : "";
      const name = brand && !p.product_name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${p.product_name}` : p.product_name;
      return { code, source: "openfoodfacts", product: fromPublic(name, p.quantity) };
    }

    const upc = await fetchJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`, fetcher);
    const item = Array.isArray(upc?.items) ? upc.items[0] : null;
    if (item?.title) {
      return { code, source: "upcitemdb", product: fromPublic(String(item.title), item.size) };
    }
  }

  return { code, source: null, product: null };
}

/** Remember what the group called a scanned product, so the next scan fills everything in. */
export function rememberProducts(db: D1Database, groupId: string, items: Pick<ItemInput, "barcode" | "name" | "quantity" | "unit" | "shares" | "priceCents" | "taxable">[]) {
  return items
    .filter((i) => i.barcode)
    .map((i) =>
      stmt(
        db,
        `INSERT INTO products (group_id, code, name, quantity, unit, shares, price_cents, taxable, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, code) DO UPDATE SET
           name = excluded.name, quantity = excluded.quantity, unit = excluded.unit, shares = excluded.shares,
           price_cents = excluded.price_cents, taxable = excluded.taxable, updated_at = excluded.updated_at`,
        groupId,
        normalizeCode(i.barcode!),
        i.name,
        i.quantity,
        i.unit,
        i.shares,
        i.priceCents,
        i.taxable,
        now(),
      ),
    );
}
