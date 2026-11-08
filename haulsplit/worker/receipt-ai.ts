/**
 * Reads receipt photos with Claude and returns structured line items.
 * Enabled when the ANTHROPIC_API_KEY secret is set.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ReceiptResult } from "../shared/api";
import { dollarsToCents } from "../shared/money";
import { defaultShares, inferQuantity, UNIT_IDS, type Unit } from "../shared/units";

const ReceiptSchema = z.object({
  store: z.string().nullable().describe("Store name and location as printed, or null"),
  purchase_date: z.string().nullable().describe("Purchase date as YYYY-MM-DD, or null if not visible"),
  items: z.array(
    z.object({
      receipt_text: z.string().describe("The item description exactly as printed"),
      name: z.string().describe("A readable product name with abbreviations expanded"),
      item_number: z.string().nullable().describe("The store item number printed before the description"),
      price: z.number().describe("Final price in dollars for this line after instant savings, including any deposit/CRV lines that belong to it"),
      discount: z.number().describe("Total instant savings applied to this item in dollars (0 if none)"),
      taxable: z.boolean().describe("True if the receipt's tax flag marks this item as taxed"),
      quantity: z.number().nullable().describe("Total pack size, e.g. 24 for a 24-count, 5 for a 5 lb bag; null if unknown"),
      unit: z.enum(UNIT_IDS as [Unit, ...Unit[]]).nullable().describe("Unit for quantity; null if unknown"),
    }),
  ),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  total: z.number().nullable(),
  warnings: z.array(z.string()).describe("Short notes about anything unreadable or uncertain"),
});

const SYSTEM = `You read photos of store receipts (usually Costco warehouse receipts) and extract the purchased items so a group of friends can split them.

Rules:
- One entry per purchased line item. Never include payment, card, change, member number, subtotal, tax or total lines as items.
- Instant savings / coupon lines (e.g. "345234 /1234567 4.00-" or "TPD/1234567 4.00-") reduce the item whose number they reference: subtract them from that item's price and record the amount as its discount.
- Bottle deposits, CRV or redemption-value lines belong to the item printed just above them: add them to that item's price.
- If a line shows a multiple like "2 @ 9.99", the line price is the total for all units; set quantity accordingly.
- taxable comes from the tax flag letter printed after the price (commonly Y, T or A for taxed; N or E or no flag for not taxed).
- name: expand Costco abbreviations into a plain product name, e.g. "KS ORG BNLS CHKN BRST" -> "Kirkland Signature Organic Boneless Chicken Breast". Don't invent details that aren't implied by the text.
- quantity/unit: use a pack size printed on the line (24CT, 5LB, 30RL, 40X16.9OZ -> 40 bottle). Otherwise use the standard Costco pack size only if you're confident; else null.
- Several photos may be overlapping sections of one long receipt. Don't count a line twice where photos overlap, but do keep genuinely repeated purchases.
- Prices are in dollars as plain numbers (21.99, not "$21.99").
- If something is unreadable, skip it and add a short warning.`;

export interface ReceiptImage {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  base64: string;
}

export interface ReceiptAIOptions {
  apiKey: string;
  model?: string;
  effort?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

export class ReceiptAIError extends Error {}

export async function parseReceiptImages(images: ReceiptImage[], opts: ReceiptAIOptions): Promise<ReceiptResult> {
  const client = new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, maxRetries: 2 });
  const effort = (["low", "medium", "high"].includes(opts.effort ?? "") ? opts.effort : "medium") as "low" | "medium" | "high";

  let response;
  try {
    response = await client.beta.messages.parse({
      model: opts.model || "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort, format: betaZodOutputFormat(ReceiptSchema) },
      messages: [
        {
          role: "user",
          content: [
            ...images.map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
            })),
            {
              type: "text" as const,
              text:
                images.length > 1
                  ? `These ${images.length} photos are parts of the same receipt, in order. Extract the line items.`
                  : "Extract the line items from this receipt.",
            },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new ReceiptAIError("The receipt scanner's API key was rejected. Check the ANTHROPIC_API_KEY secret.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ReceiptAIError("The receipt scanner is busy. Try again in a minute.");
    }
    if (err instanceof Anthropic.BadRequestError) {
      throw new ReceiptAIError(`The receipt scanner couldn't read those photos (${err.message}).`);
    }
    if (err instanceof Anthropic.APIError) {
      throw new ReceiptAIError("The receipt scanner had a problem. Try again, or paste the receipt text instead.");
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new ReceiptAIError("The receipt scanner declined these photos. Try different photos or paste the text.");
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new ReceiptAIError("That receipt was too long to read in one go. Try fewer photos at a time.");
  }

  const out = response.parsed_output;
  const items = out.items
    .filter((i) => i.price > 0)
    .map((i) => {
      const fromText = inferQuantity(i.receipt_text);
      const quantity = i.quantity && i.quantity > 0 ? i.quantity : (fromText?.quantity ?? 1);
      const unit: Unit = i.quantity && i.unit ? i.unit : (fromText?.unit ?? "item");
      return {
        name: i.name.trim() || i.receipt_text,
        rawName: i.receipt_text,
        itemNumber: i.item_number,
        priceCents: dollarsToCents(i.price),
        discountCents: dollarsToCents(Math.abs(i.discount)),
        taxable: i.taxable,
        quantity,
        unit,
        shares: defaultShares(quantity, unit),
      };
    });

  const warnings = [...out.warnings];
  const subtotalCents = out.subtotal != null ? dollarsToCents(out.subtotal) : null;
  const sum = items.reduce((s, i) => s + i.priceCents, 0);
  if (subtotalCents !== null && Math.abs(sum - subtotalCents) > 1) {
    warnings.push(
      `Items add up to $${(sum / 100).toFixed(2)} but the subtotal reads $${(subtotalCents / 100).toFixed(2)} — double-check the list.`,
    );
  }

  return {
    source: "ai",
    items,
    subtotalCents,
    taxCents: out.tax != null ? dollarsToCents(out.tax) : null,
    totalCents: out.total != null ? dollarsToCents(out.total) : null,
    purchaseDate: out.purchase_date && /^\d{4}-\d{2}-\d{2}$/.test(out.purchase_date) ? out.purchase_date : null,
    warnings,
  };
}
