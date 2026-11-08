/** Units an item's total quantity can be expressed in. */
export const UNITS = [
  { id: "lb", singular: "lb", plural: "lb" },
  { id: "oz", singular: "oz", plural: "oz" },
  { id: "kg", singular: "kg", plural: "kg" },
  { id: "ct", singular: "ct", plural: "ct" },
  { id: "pack", singular: "pack", plural: "packs" },
  { id: "bag", singular: "bag", plural: "bags" },
  { id: "bottle", singular: "bottle", plural: "bottles" },
  { id: "can", singular: "can", plural: "cans" },
  { id: "roll", singular: "roll", plural: "rolls" },
  { id: "item", singular: "item", plural: "items" },
] as const;

export type Unit = (typeof UNITS)[number]["id"];

export const UNIT_IDS = UNITS.map((u) => u.id) as Unit[];

export function isUnit(value: unknown): value is Unit {
  return typeof value === "string" && (UNIT_IDS as string[]).includes(value);
}

function trimNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatQuantity(quantity: number, unit: Unit): string {
  const def = UNITS.find((u) => u.id === unit) ?? UNITS[UNITS.length - 1];
  return `${trimNumber(quantity)} ${quantity === 1 ? def.singular : def.plural}`;
}

/** What one portion of the item is, e.g. "1 lb", "4 ct", "~1.06 lb". */
export function portionLabel(quantity: number, unit: Unit, shares: number): string {
  const each = quantity / Math.max(1, shares);
  const rounded = Math.round(each * 100) / 100;
  const approx = Math.abs(rounded - each) > 1e-9 ? "~" : "";
  return approx + formatQuantity(rounded, unit);
}

export interface QuantityGuess {
  quantity: number;
  unit: Unit;
}

/**
 * Best-effort pack-size detection from a product description, e.g.
 * "KS ORG EGGS 24CT" -> 24 ct, "NUGGETS 5LB" -> 5 lb, "WATER 40X16.9OZ" -> 40 bottles.
 */
export function inferQuantity(text: string): QuantityGuess | null {
  const t = ` ${text.toUpperCase().replace(/,/g, ".")} `;
  let m: RegExpMatchArray | null;

  // Multipacks: "40X16.9OZ", "24 X 12 OZ", "12/12OZ" -> count of containers
  if ((m = t.match(/\b(\d{1,3})\s*[X/]\s*\d+(?:\.\d+)?\s*(?:FL\.?\s*)?(?:OZ|ML|L|G)\b/))) {
    const n = Number(m[1]);
    const container = /WATER|SODA|COLA|JUICE|DRINK|SPRKL|SPARKLING|BEER|KOMBUCHA|BTL/.test(t) ? "bottle" : "ct";
    return { quantity: n, unit: container as Unit };
  }
  if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*(?:LBS?|#)(?=[^A-Z]|$)/)) || (m = t.match(/\b(\d+(?:\.\d+)?)\s*POUNDS?\b/))) {
    return { quantity: Number(m[1]), unit: "lb" };
  }
  if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*KGS?\b/))) {
    return { quantity: Number(m[1]), unit: "kg" };
  }
  if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*DO?Z\b/))) {
    return { quantity: Number(m[1]) * 12, unit: "ct" };
  }
  if ((m = t.match(/\b(\d+)\s*(?:CT|COUNT|PC|PCS|PIECES?)\b/))) {
    return { quantity: Number(m[1]), unit: "ct" };
  }
  if ((m = t.match(/\b(\d+)\s*(?:RL|ROLLS?)\b/))) {
    return { quantity: Number(m[1]), unit: "roll" };
  }
  if ((m = t.match(/\b(\d+)\s*(?:PK|PACK|PAK)\b/))) {
    return { quantity: Number(m[1]), unit: "pack" };
  }
  if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*(?:FL\.?\s*)?OZ\b/))) {
    const oz = Number(m[1]);
    // Large weights read better in pounds (e.g. 80 OZ -> 5 lb)
    if (oz >= 32 && oz % 16 === 0) return { quantity: oz / 16, unit: "lb" };
    return { quantity: oz, unit: "oz" };
  }
  return null;
}

/** Sensible default number of portions for an item of this size. */
export function defaultShares(quantity: number, unit: Unit): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 1;
  switch (unit) {
    case "lb":
      return Math.max(1, Math.round(quantity));
    case "kg":
      return Math.max(1, Math.round(quantity * 2)); // ~1.1 lb portions
    case "oz":
      return quantity >= 32 ? Math.max(1, Math.round(quantity / 16)) : 1;
    case "item":
      return Math.min(48, Math.max(1, Math.round(quantity)));
    default: {
      // Countable things: one portion per unit unless that's a lot of tapping.
      let n = Math.round(quantity);
      if (n <= 1) return 1;
      if (n <= 48) return n;
      for (const d of [2, 3, 4, 5, 6, 8, 10, 12]) {
        if (n % d === 0 && n / d <= 48) return n / d;
      }
      return 48;
    }
  }
}

/** Parses quantity strings from product databases: "2.27 kg", "5 lb", "80 oz", "24 x 500 ml". */
export function parseQuantityString(text: string | null | undefined): QuantityGuess | null {
  if (!text) return null;
  const guess = inferQuantity(text.replace(/(\d)\s+(?=(?:lb|lbs|oz|kg|ct|pk)\b)/gi, "$1"));
  if (guess) return guess;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*g\b/i);
  if (m) {
    const grams = Number(m[1].replace(",", "."));
    if (grams >= 450) return { quantity: Math.round((grams / 453.592) * 100) / 100, unit: "lb" };
    return { quantity: Math.round((grams / 28.3495) * 10) / 10, unit: "oz" };
  }
  return null;
}
