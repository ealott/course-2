/**
 * The math for splitting a haul.
 *
 * Every item is divided into `shares` equal portions. A portion costs
 * price * (1 + tax) / shares. Each person's line for an item is rounded to the
 * cent once, and their total is the sum of their rounded lines, so the numbers
 * people see always add up. Unclaimed portions stay with the organizer.
 */

export interface SplitClaim {
  userId: string;
  shares: number;
}

export interface SplitItem {
  id: string;
  priceCents: number;
  shares: number;
  taxable: boolean;
  claims: SplitClaim[];
}

export interface PersonLine {
  itemId: string;
  shares: number;
  cents: number;
}

export interface PersonTotal {
  userId: string;
  lines: PersonLine[];
  totalCents: number;
}

export interface HaulTotals {
  /** Everyone who has claimed anything, keyed by user id. */
  people: Record<string, PersonTotal>;
  /** Cost of the whole haul including tax. */
  haulCents: number;
  claimedCents: number;
  /** Cost of portions nobody has claimed (the organizer keeps these). */
  unclaimedCents: number;
  unclaimedShares: Record<string, number>;
}

export function itemCostCents(item: Pick<SplitItem, "priceCents" | "taxable">, taxRatePct: number): number {
  return item.priceCents * (item.taxable ? 1 + taxRatePct / 100 : 1);
}

/** Exact (unrounded) cost of one portion. */
export function perShareCents(item: Pick<SplitItem, "priceCents" | "taxable" | "shares">, taxRatePct: number): number {
  return itemCostCents(item, taxRatePct) / Math.max(1, item.shares);
}

export function lineCents(
  item: Pick<SplitItem, "priceCents" | "taxable" | "shares">,
  shares: number,
  taxRatePct: number,
): number {
  if (shares <= 0) return 0;
  return Math.round(perShareCents(item, taxRatePct) * shares);
}

export function claimedShares(item: Pick<SplitItem, "claims">): number {
  return item.claims.reduce((sum, c) => sum + c.shares, 0);
}

export function computeTotals(items: SplitItem[], taxRatePct: number): HaulTotals {
  const people: Record<string, PersonTotal> = {};
  const unclaimedShares: Record<string, number> = {};
  let haulCents = 0;
  let claimedCents = 0;

  for (const item of items) {
    const itemCents = Math.round(itemCostCents(item, taxRatePct));
    haulCents += itemCents;
    let itemClaimed = 0;
    for (const claim of item.claims) {
      if (claim.shares <= 0) continue;
      const cents = lineCents(item, claim.shares, taxRatePct);
      const person = (people[claim.userId] ??= { userId: claim.userId, lines: [], totalCents: 0 });
      person.lines.push({ itemId: item.id, shares: claim.shares, cents });
      person.totalCents += cents;
      claimedCents += cents;
      itemClaimed += claim.shares;
    }
    const left = item.shares - itemClaimed;
    if (left > 0) unclaimedShares[item.id] = left;
  }

  return {
    people,
    haulCents,
    claimedCents,
    unclaimedCents: haulCents - claimedCents,
    unclaimedShares,
  };
}

/** Tax rate in percent from the receipt's tax line and the taxable subtotal. */
export function taxRateFromReceipt(taxCents: number, taxableSubtotalCents: number): number {
  if (taxCents <= 0 || taxableSubtotalCents <= 0) return 0;
  return Math.round((taxCents / taxableSubtotalCents) * 100 * 1000) / 1000;
}

export type SettlementState =
  | { kind: "none" } // nothing claimed
  | { kind: "selecting"; totalCents: number }
  | { kind: "owes"; totalCents: number; owedCents: number; paidCents: number }
  | { kind: "sent"; totalCents: number; paidCents: number } // member says they paid, organizer hasn't confirmed
  | { kind: "paid"; totalCents: number }
  | { kind: "refund"; totalCents: number; refundCents: number }; // member paid more than they now owe

export interface SettlementLike {
  confirmedAt: number | null;
  paidCents: number;
  verifiedCents: number;
}

export function settlementState(totalCents: number, s: SettlementLike | undefined, isOrganizer = false): SettlementState {
  if (isOrganizer) return totalCents > 0 ? { kind: "paid", totalCents } : { kind: "none" };
  const paid = s?.paidCents ?? 0;
  const verified = s?.verifiedCents ?? 0;
  if (totalCents <= 0 && paid <= 0) return { kind: "none" };
  if (paid > totalCents) return { kind: "refund", totalCents, refundCents: paid - totalCents };
  if (paid === totalCents && totalCents > 0) {
    return verified >= totalCents ? { kind: "paid", totalCents } : { kind: "sent", totalCents, paidCents: paid };
  }
  if (!s?.confirmedAt && paid === 0) return { kind: "selecting", totalCents };
  return { kind: "owes", totalCents, owedCents: totalCents - paid, paidCents: paid };
}
