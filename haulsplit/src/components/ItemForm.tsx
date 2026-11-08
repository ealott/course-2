import { useCallback, useState, type FormEvent } from "react";
import type { Item, ItemInput, ProductLookup } from "../../shared/api";
import { formatCents, parseDollars } from "../../shared/money";
import { lineCents } from "../../shared/split";
import { UNITS, defaultShares, formatQuantity, inferQuantity, portionLabel, type Unit } from "../../shared/units";
import { api } from "../api";
import { addDays, todayISO } from "../dates";
import { Icon, Sheet, errorMessage } from "../ui";
import { BarcodeScanner } from "./BarcodeScanner";

export function portionChoices(quantity: number, unit: Unit): { label: string; shares: number }[] {
  const out: { label: string; shares: number }[] = [{ label: "Whole", shares: 1 }];
  const add = (label: string, shares: number) => {
    if (shares >= 2 && shares <= 500 && !out.some((o) => o.shares === shares)) out.push({ label, shares });
  };
  add("Halves", 2);
  add("Thirds", 3);
  add("Quarters", 4);
  const unitLabel = UNITS.find((u) => u.id === unit)?.singular ?? unit;
  if (unit !== "item" && Number.isInteger(quantity)) add(`Per ${unitLabel} (${quantity})`, quantity);
  if (unit === "lb" && quantity >= 2) add("½ lb each", Math.round(quantity * 2));
  if (unit === "item" && Number.isInteger(quantity)) add(`Each (${quantity})`, quantity);
  return out;
}

export function ItemForm({
  groupId,
  taxRate,
  item,
  claimed = 0,
  autoScan = false,
  onSave,
  onDelete,
  onClose,
}: {
  groupId: string;
  taxRate: number;
  item?: Item;
  claimed?: number;
  autoScan?: boolean;
  onSave: (input: ItemInput, addAnother: boolean) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [price, setPrice] = useState(item ? (item.priceCents / 100).toFixed(2) : "");
  const [quantity, setQuantity] = useState(item ? String(item.quantity) : "1");
  const [unit, setUnit] = useState<Unit>(item?.unit ?? "item");
  const [shares, setShares] = useState(item ? String(item.shares) : "1");
  const [sharesTouched, setSharesTouched] = useState(!!item);
  const [taxable, setTaxable] = useState(item?.taxable ?? false);
  const [expiresOn, setExpiresOn] = useState(item?.expiresOn ?? "");
  const [barcode, setBarcode] = useState(item?.barcode ?? "");
  const [itemNumber, setItemNumber] = useState(item?.itemNumber ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [scanning, setScanning] = useState(autoScan);
  const [lookupNote, setLookupNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const qty = Number(quantity);
  const shareCount = Math.round(Number(shares));
  const priceCents = parseDollars(price);
  const valid = name.trim() && priceCents !== null && qty > 0 && shareCount >= 1;

  function setQuantityAndMaybeShares(q: string, u: Unit) {
    setQuantity(q);
    setUnit(u);
    if (!sharesTouched && Number(q) > 0) setShares(String(defaultShares(Number(q), u)));
  }

  function onNameBlur() {
    // "Eggs 24CT" -> 24 ct, if the size hasn't been set yet.
    if (quantity === "1" && unit === "item") {
      const guess = inferQuantity(name);
      if (guess) setQuantityAndMaybeShares(String(guess.quantity), guess.unit);
    }
  }

  const onDetected = useCallback(
    async (code: string) => {
      setScanning(false);
      setBarcode(code);
      setLookupNote("Looking up…");
      try {
        const res = await api<ProductLookup>("GET", `/groups/${groupId}/products/${encodeURIComponent(code)}`);
        setBarcode(res.code);
        const p = res.product;
        if (!p) {
          setLookupNote("Not found in any product database — type the details in. We'll remember them next time.");
          return;
        }
        setName(p.name);
        if (p.quantity && p.unit) {
          setQuantity(String(p.quantity));
          setUnit(p.unit);
          // Suggested, not chosen: changing the size afterwards still re-suggests portions.
          setShares(String(p.shares ?? defaultShares(p.quantity, p.unit)));
          setSharesTouched(false);
        }
        if (p.priceCents != null) setPrice((p.priceCents / 100).toFixed(2));
        if (p.taxable != null) setTaxable(p.taxable);
        setLookupNote(
          res.source === "group"
            ? "Filled in from last time your group bought this. Check the price."
            : "Found it. Add the price you paid and check the size.",
        );
      } catch (err) {
        setLookupNote(errorMessage(err));
      }
    },
    [groupId],
  );

  async function submit(e: FormEvent, addAnother = false) {
    e.preventDefault();
    if (!valid) return;
    if (shareCount < claimed) {
      setError(`${claimed} portions are already claimed, so it needs at least ${claimed}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave(
        {
          name: name.trim(),
          priceCents: priceCents!,
          quantity: qty,
          unit,
          shares: shareCount,
          taxable,
          expiresOn: expiresOn || null,
          barcode: barcode || null,
          itemNumber: itemNumber || null,
          notes: notes || null,
        },
        addAnother,
      );
      if (addAnother) {
        setName("");
        setPrice("");
        setQuantity("1");
        setUnit("item");
        setShares("1");
        setSharesTouched(false);
        setTaxable(false);
        setExpiresOn("");
        setBarcode("");
        setItemNumber("");
        setNotes("");
        setLookupNote("");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const today = todayISO();
  const perPortion = valid ? lineCents({ priceCents: priceCents!, taxable, shares: shareCount }, 1, taxRate) : null;

  return (
    <>
      <Sheet title={item ? "Edit item" : "Add an item"} onClose={onClose}>
        <form className="stack" onSubmit={(e) => submit(e)}>
          <button type="button" className="btn soft block" onClick={() => setScanning(true)}>
            <Icon name="barcode" /> {barcode ? `Barcode ${barcode} · scan again` : "Scan barcode to fill in"}
          </button>
          {lookupNote && <p className="small muted">{lookupNote}</p>}

          <div className="field">
            <label htmlFor="item-name">What is it?</label>
            <input
              id="item-name"
              className="input"
              placeholder="e.g. Chicken breast"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={onNameBlur}
              required
              maxLength={120}
            />
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="item-price">Price paid</label>
              <div className="input-prefix">
                <span>$</span>
                <input
                  id="item-price"
                  className="input num"
                  inputMode="decimal"
                  placeholder="21.99"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="item-qty">Total size</label>
              <div className="row" style={{ gap: 6 }}>
                <input
                  id="item-qty"
                  className="input num"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantityAndMaybeShares(e.target.value, unit)}
                  style={{ minWidth: 0 }}
                  aria-label="Quantity"
                />
                <select
                  className="input"
                  value={unit}
                  onChange={(e) => setQuantityAndMaybeShares(quantity, e.target.value as Unit)}
                  aria-label="Unit"
                  style={{ width: 96, flexShrink: 0 }}
                >
                  {UNITS.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.plural}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="item-shares">Split into portions</label>
            <div className="row">
              <input
                id="item-shares"
                className="input num"
                inputMode="numeric"
                value={shares}
                onChange={(e) => {
                  setShares(e.target.value.replace(/\D/g, ""));
                  setSharesTouched(true);
                }}
                style={{ width: 90 }}
              />
              <span className="small muted grow">
                {valid ? (
                  <>
                    {portionLabel(qty, unit, shareCount)} each · <b className="num">{formatCents(perPortion!)}</b> per portion
                    {taxable && taxRate > 0 ? " incl. tax" : ""}
                  </>
                ) : (
                  "People pick how many portions they want."
                )}
              </span>
            </div>
            {qty > 0 && (
              <div className="chips">
                {portionChoices(qty, unit).map((c) => (
                  <button
                    type="button"
                    key={c.label}
                    className={`chip${shareCount === c.shares ? " on" : ""}`}
                    onClick={() => {
                      setShares(String(c.shares));
                      setSharesTouched(true);
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor="item-expires">Use or freeze by</label>
            <input id="item-expires" className="input" type="date" value={expiresOn} min={item ? undefined : today} onChange={(e) => setExpiresOn(e.target.value)} />
            <div className="chips">
              {[
                ["3 days", 3],
                ["5 days", 5],
                ["1 week", 7],
                ["2 weeks", 14],
                ["1 month", 30],
              ].map(([label, days]) => (
                <button type="button" key={label} className="chip" onClick={() => setExpiresOn(addDays(today, days as number))}>
                  +{label}
                </button>
              ))}
              {expiresOn && (
                <button type="button" className="chip" onClick={() => setExpiresOn("")}>
                  None
                </button>
              )}
            </div>
          </div>

          <label className="check">
            <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
            <span>
              Taxed item
              <span className="hint" style={{ display: "block" }}>
                Tick for things the receipt charged sales tax on (usually not groceries).
              </span>
            </span>
          </label>

          <details>
            <summary className="small muted strong">More details</summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="item-number">Store item #</label>
                  <input id="item-number" className="input" value={itemNumber} onChange={(e) => setItemNumber(e.target.value)} maxLength={20} />
                </div>
                <div className="field">
                  <label htmlFor="item-barcode">Barcode</label>
                  <input id="item-barcode" className="input" inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value.trim())} maxLength={32} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="item-notes">Notes</label>
                <input
                  id="item-notes"
                  className="input"
                  placeholder="e.g. 2 packs of 4 breasts each"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={300}
                />
              </div>
            </div>
          </details>

          {valid && (
            <p className="small muted">
              {formatQuantity(qty, unit)} for {formatCents(priceCents!)} → {shareCount} portion{shareCount === 1 ? "" : "s"}
            </p>
          )}
          {error && <p className="error-text">{error}</p>}

          <div className="row">
            {item && onDelete ? (
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  const msg = claimed > 0 ? `${claimed} portions are claimed. Delete "${item.name}" anyway?` : `Delete "${item.name}"?`;
                  if (!window.confirm(msg)) return;
                  setBusy(true);
                  try {
                    await onDelete();
                  } catch (err) {
                    setError(errorMessage(err));
                    setBusy(false);
                  }
                }}
              >
                <Icon name="trash" size={18} /> Delete
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy || !valid} onClick={(e) => submit(e, true)}>
                Save &amp; add another
              </button>
            )}
            <button className="btn primary grow" disabled={busy || !valid}>
              {busy ? <span className="spinner" /> : item ? "Save" : "Add item"}
            </button>
          </div>
        </form>
      </Sheet>
      {scanning && <BarcodeScanner onDetected={onDetected} onClose={() => setScanning(false)} />}
    </>
  );
}
