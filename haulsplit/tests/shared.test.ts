import { describe, expect, it } from "vitest";
import { formatCents, parseDollars } from "../shared/money";
import { parseReceiptText, prettifyName } from "../shared/receipt";
import { computeTotals, lineCents, settlementState, taxRateFromReceipt, type SplitItem } from "../shared/split";
import { defaultShares, inferQuantity, parseQuantityString, portionLabel } from "../shared/units";

describe("money", () => {
  it("formats cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(2199)).toBe("$21.99");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-550)).toBe("-$5.50");
  });
  it("parses dollars", () => {
    expect(parseDollars("$21.99")).toBe(2199);
    expect(parseDollars("21")).toBe(2100);
    expect(parseDollars("1,234.5")).toBe(123450);
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
});

describe("units", () => {
  it("infers pack sizes from receipt text", () => {
    expect(inferQuantity("KS ORG EGGS 24CT")).toEqual({ quantity: 24, unit: "ct" });
    expect(inferQuantity("KS NUGGETS 5LB")).toEqual({ quantity: 5, unit: "lb" });
    expect(inferQuantity("CHKN NUGGET 5#")).toEqual({ quantity: 5, unit: "lb" });
    expect(inferQuantity("KS WATER 40X16.9OZ")).toEqual({ quantity: 40, unit: "bottle" });
    expect(inferQuantity("KS TP 30RL")).toEqual({ quantity: 30, unit: "roll" });
    expect(inferQuantity("EGGS 5DZ")).toEqual({ quantity: 60, unit: "ct" });
    expect(inferQuantity("PEANUT BUTTER 80 OZ")).toEqual({ quantity: 5, unit: "lb" });
    expect(inferQuantity("KS CHKN BRST")).toBeNull();
  });
  it("parses product database quantities", () => {
    expect(parseQuantityString("2.27 kg")).toEqual({ quantity: 2.27, unit: "kg" });
    expect(parseQuantityString("5 lb")).toEqual({ quantity: 5, unit: "lb" });
    expect(parseQuantityString("907 g")).toEqual({ quantity: 2, unit: "lb" });
  });
  it("picks default portions", () => {
    expect(defaultShares(8, "lb")).toBe(8);
    expect(defaultShares(6.37, "lb")).toBe(6);
    expect(defaultShares(24, "ct")).toBe(24);
    expect(defaultShares(60, "ct")).toBe(30);
    expect(defaultShares(1, "item")).toBe(1);
  });
  it("labels portions", () => {
    expect(portionLabel(8, "lb", 8)).toBe("1 lb");
    expect(portionLabel(6.37, "lb", 6)).toBe("~1.06 lb");
    expect(portionLabel(24, "ct", 6)).toBe("4 ct");
    expect(portionLabel(6, "pack", 6)).toBe("1 pack");
  });
});

describe("split math", () => {
  const chicken: SplitItem = {
    id: "chicken",
    priceCents: 2200, // 8 lb
    shares: 8,
    taxable: false,
    claims: [
      { userId: "mom", shares: 3 },
      { userId: "dave", shares: 2 },
    ],
  };
  const towels: SplitItem = {
    id: "towels",
    priceCents: 2399,
    shares: 12,
    taxable: true,
    claims: [{ userId: "mom", shares: 6 }],
  };

  it("charges per portion and leaves the rest unclaimed", () => {
    const totals = computeTotals([chicken], 0);
    expect(totals.people.mom.totalCents).toBe(825);
    expect(totals.people.dave.totalCents).toBe(550);
    expect(totals.unclaimedShares.chicken).toBe(3);
    expect(totals.haulCents).toBe(2200);
    expect(totals.unclaimedCents).toBe(2200 - 825 - 550);
  });

  it("adds tax only to taxable items", () => {
    const totals = computeTotals([chicken, towels], 9.25);
    // half the towels: 23.99 * 1.0925 / 2 = 13.1045 -> $13.10
    expect(lineCents(towels, 6, 9.25)).toBe(1310);
    expect(totals.people.mom.totalCents).toBe(825 + 1310);
    expect(totals.haulCents).toBe(2200 + Math.round(2399 * 1.0925));
  });

  it("a single claimer of everything pays the item total", () => {
    const item: SplitItem = { id: "x", priceCents: 1999, shares: 3, taxable: true, claims: [{ userId: "a", shares: 3 }] };
    const totals = computeTotals([item], 8.875);
    expect(totals.people.a.totalCents).toBe(Math.round(1999 * 1.08875));
    expect(totals.unclaimedCents).toBe(0);
  });

  it("derives a tax rate from the receipt", () => {
    expect(taxRateFromReceipt(222, 2399)).toBe(9.254);
    expect(taxRateFromReceipt(0, 1000)).toBe(0);
  });

  it("tracks settlement state", () => {
    expect(settlementState(0, undefined).kind).toBe("none");
    expect(settlementState(1000, undefined).kind).toBe("selecting");
    expect(settlementState(1000, { confirmedAt: 1, paidCents: 0, verifiedCents: 0 })).toMatchObject({ kind: "owes", owedCents: 1000 });
    expect(settlementState(1000, { confirmedAt: 1, paidCents: 1000, verifiedCents: 0 }).kind).toBe("sent");
    expect(settlementState(1000, { confirmedAt: 1, paidCents: 1000, verifiedCents: 1000 }).kind).toBe("paid");
    expect(settlementState(1500, { confirmedAt: 1, paidCents: 1000, verifiedCents: 1000 })).toMatchObject({ kind: "owes", owedCents: 500 });
    expect(settlementState(800, { confirmedAt: 1, paidCents: 1000, verifiedCents: 1000 })).toMatchObject({ kind: "refund", refundCents: 200 });
  });
});

describe("receipt parser", () => {
  const receipt = `
COSTCO WHOLESALE
Mountain View #143
E   1234567 KS CHKN BRST       21.99 N
E   512515 KS ORG EGGS 24CT     8.49 N
E   1100212 CHKN NUGGET 5LB    15.99 N
    987654 KS PAPER TOWEL 12RL 23.99 Y
    345234 /987654              4.00-Y
    1645 KS WATER 40X16.9OZ     3.99 Y
    1015 CA REDEMP VA           2.00 Y
              SUBTOTAL          72.45
              TAX                1.83
         **** TOTAL             74.28
XXXXXXXXXXXX1234 CHIP READ
VISA                           74.28
11/07/2026 14:32 148 23 101 32
TOTAL NUMBER OF ITEMS SOLD = 5
`;

  it("parses items, discounts, deposits and totals", () => {
    const parsed = parseReceiptText(receipt);
    expect(parsed.items.map((i) => i.rawName)).toEqual([
      "KS CHKN BRST",
      "KS ORG EGGS 24CT",
      "CHKN NUGGET 5LB",
      "KS PAPER TOWEL 12RL",
      "KS WATER 40X16.9OZ",
    ]);
    const [chicken, eggs, nuggets, towels, water] = parsed.items;
    expect(chicken).toMatchObject({ itemNumber: "1234567", priceCents: 2199, taxable: false, unit: "item", shares: 1 });
    expect(eggs).toMatchObject({ quantity: 24, unit: "ct", shares: 24 });
    expect(nuggets).toMatchObject({ quantity: 5, unit: "lb", shares: 5 });
    expect(towels).toMatchObject({ priceCents: 1999, discountCents: 400, taxable: true, quantity: 12, unit: "roll" });
    expect(water).toMatchObject({ priceCents: 599, taxable: true, quantity: 40, unit: "bottle" });
    expect(parsed.subtotalCents).toBe(7245);
    expect(parsed.taxCents).toBe(183);
    expect(parsed.totalCents).toBe(7428);
    expect(parsed.purchaseDate).toBe("2026-11-07");
    expect(parsed.warnings).toEqual([]);
  });

  it("warns when items don't add up", () => {
    const parsed = parseReceiptText("1234567 KS CHKN BRST 21.99 N\nSUBTOTAL 50.00\n");
    expect(parsed.warnings[0]).toMatch(/subtotal/);
  });

  it("handles multi-quantity lines", () => {
    const parsed = parseReceiptText("2 @ 9.99\n1234 KS ALMOND MILK 19.98 N\n");
    expect(parsed.items[0]).toMatchObject({ quantity: 2, unit: "item", shares: 2, priceCents: 1998 });
  });

  it("prettifies Costco abbreviations", () => {
    expect(prettifyName("KS ORG BNLS SKNLS CHKN BRST")).toBe("Kirkland Signature Organic Boneless Skinless Chicken Breast");
    expect(prettifyName("KS ORG EGGS 24CT")).toBe("Kirkland Signature Organic Eggs 24 ct");
  });
});
