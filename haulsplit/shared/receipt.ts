/**
 * Parses the text of a Costco warehouse receipt (pasted, or copied out of a
 * photo with the phone's Live Text) into line items.
 *
 * Typical lines look like:
 *   E   1234567 KS CHKN BRST    21.99 N
 *       987654 PAPER TOWEL      23.99 Y
 *       345234 /987654           4.00-
 *              SUBTOTAL         150.23
 *              TAX                2.13
 *         **** TOTAL            152.36
 */
import { defaultShares, inferQuantity, type Unit } from "./units";

export interface ReceiptLine {
  /** Readable name, e.g. "Kirkland Signature Chicken Breast". */
  name: string;
  /** The text as printed, e.g. "KS CHKN BRST". */
  rawName: string;
  itemNumber: string | null;
  /** Net price after instant savings and with deposits folded in. */
  priceCents: number;
  discountCents: number;
  taxable: boolean;
  quantity: number;
  unit: Unit;
  shares: number;
}

export interface ParsedReceipt {
  items: ReceiptLine[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  purchaseDate: string | null;
  warnings: string[];
}

const PRICE = String.raw`(\d{1,4}[.,]\d{2})`;

const SKIP =
  /\b(SUBTOTAL|SUB TOTAL|TOTAL|CHANGE|VISA|MASTERCARD|MASTER CARD|AMEX|DISCOVER|DEBIT|CREDIT|CASH|EBT|APPROVED|AUTH|AID:|TRAN|SEQ|MERCHANT|RESP|WHSE|TRM|TRN|OP#|OP:|ITEMS SOLD|NUMBER OF ITEMS|THANK YOU|COME AGAIN|MEMBER|BOTTOM OF BASKET|BOB COUNT|INSTANT SAVINGS|TOTAL SAVINGS|EXECUTIVE|REWARD|PURCHASE|CHIP READ|BALANCE|TENDER|CASHBACK)\b/;

const DEPOSIT = /\b(CRV|REDEMP|REDEMPTION|DEPOSIT|BTL DEP|BOTTLE DEP|ENV FEE|RECYCL)/;

const ABBREVIATIONS: Record<string, string> = {
  KS: "Kirkland Signature",
  KIRKLAND: "Kirkland",
  ORG: "Organic",
  ORGNC: "Organic",
  CHKN: "Chicken",
  CHK: "Chicken",
  CHIC: "Chicken",
  BRST: "Breast",
  BRT: "Breast",
  BNLS: "Boneless",
  SKNLS: "Skinless",
  SKLS: "Skinless",
  THGH: "Thigh",
  THGHS: "Thighs",
  GRND: "Ground",
  GRD: "Ground",
  BF: "Beef",
  TKY: "Turkey",
  TRKY: "Turkey",
  PRK: "Pork",
  SLMN: "Salmon",
  SALM: "Salmon",
  SHRMP: "Shrimp",
  FZ: "Frozen",
  FRZ: "Frozen",
  FZN: "Frozen",
  FRZN: "Frozen",
  NUGG: "Nuggets",
  NUGGS: "Nuggets",
  RTSRE: "Rotisserie",
  ROTIS: "Rotisserie",
  BRGR: "Burger",
  BRGRS: "Burgers",
  SAUS: "Sausage",
  SSG: "Sausage",
  BCN: "Bacon",
  STK: "Steak",
  SRLN: "Sirloin",
  TNDRLN: "Tenderloin",
  ATL: "Atlantic",
  WLD: "Wild",
  VEG: "Vegetable",
  VEGS: "Vegetables",
  BROC: "Broccoli",
  BRCLI: "Broccoli",
  SPNCH: "Spinach",
  ROM: "Romaine",
  STRWBRY: "Strawberries",
  STRAWB: "Strawberries",
  BLUBRY: "Blueberries",
  BLBRY: "Blueberries",
  RASPB: "Raspberries",
  AVOC: "Avocados",
  AVO: "Avocados",
  BAN: "Bananas",
  TOM: "Tomatoes",
  POT: "Potatoes",
  CHS: "Cheese",
  CHSE: "Cheese",
  SHRD: "Shredded",
  MOZZ: "Mozzarella",
  PARM: "Parmesan",
  CHED: "Cheddar",
  YOG: "Yogurt",
  YGRT: "Yogurt",
  GRK: "Greek",
  MLK: "Milk",
  BTR: "Butter",
  UNSLT: "Unsalted",
  LG: "Large",
  XLG: "Extra Large",
  TP: "Toilet Paper",
  BTH: "Bath",
  TISS: "Tissue",
  PT: "Paper Towels",
  TWL: "Towels",
  DET: "Detergent",
  LIQ: "Liquid",
  WTR: "Water",
  SPRKL: "Sparkling",
  OJ: "Orange Juice",
  JCE: "Juice",
  CRSNT: "Croissants",
  BAGL: "Bagels",
  MUFF: "Muffins",
  BRD: "Bread",
  TORT: "Tortillas",
  PB: "Peanut Butter",
  EVOO: "Extra Virgin Olive Oil",
  W: "with",
};

const KEEP_UPPER = new Set(["NY", "BBQ", "USDA", "XL", "IPA", "OJ"]);

function cleanToken(token: string): string {
  const upper = token.toUpperCase();
  if (ABBREVIATIONS[upper]) return ABBREVIATIONS[upper];
  if (KEEP_UPPER.has(upper)) return upper;
  // Pack sizes: 24CT -> 24 ct, 5LB -> 5 lb, 5# -> 5 lb
  const size = upper.match(/^(\d+(?:\.\d+)?)(CT|LB|LBS|#|OZ|PK|RL|KG|DZ)$/);
  if (size) {
    const unit = { CT: "ct", LB: "lb", LBS: "lb", "#": "lb", OZ: "oz", PK: "pk", RL: "rolls", KG: "kg", DZ: "dozen" }[size[2]]!;
    return `${size[1]} ${unit}`;
  }
  if (/\d/.test(token)) return token.toLowerCase();
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

/** "KS ORG BNLS CHKN BRST" -> "Kirkland Signature Organic Boneless Chicken Breast" */
export function prettifyName(raw: string): string {
  const words = raw.replace(/[*]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const pretty = words.map(cleanToken).join(" ").replace(/\s+/g, " ").trim();
  return pretty || raw.trim();
}

function toCents(price: string): number {
  return Math.round(Number(price.replace(",", ".")) * 100);
}

function isTaxFlag(flag: string | undefined): boolean {
  return flag !== undefined && /^[YTA]$/.test(flag);
}

interface Pending extends ReceiptLine {
  multiplier?: number;
}

export function parseReceiptText(text: string): ParsedReceipt {
  const warnings: string[] = [];
  const items: Pending[] = [];
  let subtotalCents: number | null = null;
  let taxCents: number | null = null;
  let totalCents: number | null = null;
  let purchaseDate: string | null = null;
  let pendingMultiplier: number | null = null;

  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\t/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const original of lines) {
    const line = original.toUpperCase();

    const date = line.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (date && !purchaseDate) {
      const year = date[3].length === 2 ? `20${date[3]}` : date[3];
      const month = Number(date[1]);
      const day = Number(date[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        purchaseDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }

    // Totals
    let m: RegExpMatchArray | null;
    if ((m = line.match(new RegExp(String.raw`^SUB\s?TOTAL\s+\$?${PRICE}`)))) {
      subtotalCents = toCents(m[1]);
      continue;
    }
    if ((m = line.match(new RegExp(String.raw`^(?:[A-Z]\s+)?(?:\d+(?:\.\d+)?\s*%\s+)?(?:SALES\s+)?TAX\s+\$?${PRICE}`)))) {
      taxCents = (taxCents ?? 0) + toCents(m[1]);
      continue;
    }
    if ((m = line.match(new RegExp(String.raw`^\**\s*TOTAL\s+\$?${PRICE}`)))) {
      if (totalCents === null) totalCents = toCents(m[1]);
      continue;
    }

    // "2 @ 9.99" quantity lines
    if ((m = line.match(new RegExp(String.raw`^(\d{1,3})\s*@\s*\$?${PRICE}`)))) {
      const qty = Number(m[1]);
      const unit = toCents(m[2]);
      const prev = items[items.length - 1];
      if (prev && prev.priceCents === qty * unit) {
        prev.multiplier = qty;
      } else {
        pendingMultiplier = qty;
      }
      continue;
    }

    // Instant savings: "345234 /987654 4.00-", "TPD/987654 4.00-"
    if ((m = line.match(new RegExp(String.raw`(?:^|\s)(?:\d{3,8}\s*)?(?:TPD\s*)?\/\s*(\d{3,8})\s+\$?${PRICE}\s*-`)))) {
      const ref = m[1];
      const amount = toCents(m[2]);
      const target = [...items].reverse().find((i) => i.itemNumber === ref) ?? items[items.length - 1];
      if (target) {
        target.priceCents -= amount;
        target.discountCents += amount;
      } else {
        warnings.push(`Couldn't match a discount of ${(amount / 100).toFixed(2)} to an item.`);
      }
      continue;
    }

    if (SKIP.test(line)) continue;

    // Item line: [E] 1234567 DESCRIPTION 21.99 [-] [N|Y|A]
    m = line.match(new RegExp(String.raw`^(?:[A-Z]{1,2}\s+)?(\d{3,8})\s+(.+?)\s+\$?${PRICE}\s*(-)?\s*([A-Z])?$`));
    let itemNumber: string | null = null;
    let desc: string;
    let price: string;
    let negative: boolean;
    let flag: string | undefined;
    if (m) {
      [, itemNumber, desc, price] = m as unknown as [string, string, string, string];
      negative = m[4] === "-";
      flag = m[5];
    } else {
      // Item lines where OCR dropped the item number.
      const loose = line.match(new RegExp(String.raw`^(?:[A-Z]\s+)?([A-Z][A-Z0-9 .&'/#%-]{2,}?)\s+\$?${PRICE}\s*(-)?\s*([A-Z])?$`));
      if (!loose) continue;
      desc = loose[1];
      price = loose[2];
      negative = loose[3] === "-";
      flag = loose[4];
    }

    const cents = toCents(price);
    if (negative) {
      const target = items[items.length - 1];
      if (target) {
        target.priceCents -= cents;
        target.discountCents += cents;
      }
      continue;
    }

    if (DEPOSIT.test(desc)) {
      const target = items[items.length - 1];
      if (target) {
        target.priceCents += cents;
        continue;
      }
    }

    const rawName = desc.trim();
    const guess = inferQuantity(rawName);
    const item: Pending = {
      name: prettifyName(rawName),
      rawName,
      itemNumber,
      priceCents: cents,
      discountCents: 0,
      taxable: isTaxFlag(flag),
      quantity: guess?.quantity ?? 1,
      unit: guess?.unit ?? "item",
      shares: 1,
    };
    if (pendingMultiplier && pendingMultiplier > 1) {
      item.multiplier = pendingMultiplier;
    }
    pendingMultiplier = null;
    items.push(item);
  }

  const result: ReceiptLine[] = items.map(({ multiplier, ...item }) => {
    if (multiplier && multiplier > 1) {
      if (item.unit === "item") {
        item.quantity = multiplier;
      } else {
        item.quantity = item.quantity * multiplier;
      }
      item.name = `${item.name} (×${multiplier})`;
    }
    item.shares = defaultShares(item.quantity, item.unit);
    return item;
  });

  if (result.length === 0) {
    warnings.push("No items found. Make sure each line has the item and its price.");
  }
  const itemSum = result.reduce((s, i) => s + i.priceCents, 0);
  if (subtotalCents !== null && result.length > 0 && Math.abs(itemSum - subtotalCents) > 1) {
    warnings.push(
      `Items add up to $${(itemSum / 100).toFixed(2)} but the receipt subtotal is $${(subtotalCents / 100).toFixed(2)} — some lines may be missing or misread.`,
    );
  }
  if ((taxCents ?? 0) > 0 && !result.some((i) => i.taxable)) {
    warnings.push("The receipt has tax but no items were marked taxable — check the taxable boxes.");
  }

  return { items: result, subtotalCents, taxCents, totalCents, purchaseDate, warnings };
}
