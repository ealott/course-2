/** Money is always handled as integer cents. */

export function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

/** Plain "12.34" (no $ or commas) — handy for copy-to-clipboard into a payment app. */
export function centsToPlain(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** Parses "$1,234.5", "21.99", "21" into cents. Returns null if not a number. */
export function parseDollars(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^-?\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === "" || cleaned === "-" || cleaned === ".") {
    return null;
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function dollarsToCents(value: number): number {
  return Math.round(value * 100);
}
