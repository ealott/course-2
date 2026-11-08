import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { HaulDetail, ReceiptResult } from "../../shared/api";
import { formatCents, parseDollars } from "../../shared/money";
import { taxRateFromReceipt } from "../../shared/split";
import { UNITS, defaultShares, formatQuantity, type Unit } from "../../shared/units";
import { api, useApi } from "../api";
import { portionChoices } from "../components/ItemForm";
import { addDays, formatDate, todayISO } from "../dates";
import { useSession } from "../session";
import { ErrorState, Icon, Loading, TopBar, errorMessage } from "../ui";

interface Row {
  include: boolean;
  name: string;
  rawName: string;
  itemNumber: string | null;
  discountCents: number;
  price: string;
  quantity: string;
  unit: Unit;
  shares: string;
  taxable: boolean;
  expiresOn: string;
}

interface Photo {
  blob: Blob;
  url: string;
}

/** Phone photos are huge; shrink to what the model can use (≤2400px on the long edge). */
async function shrink(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));
  } catch {
    return file; // let the server judge it
  }
}

export function ReceiptImport() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { config } = useSession();
  const haul = useApi<HaulDetail>(`/hauls/${id}`);
  const [mode, setMode] = useState<"photo" | "text">(config.aiReceipts ? "photo" : "text");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReceiptResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [applyTax, setApplyTax] = useState(true);
  const [applyDate, setApplyDate] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => setMode(config.aiReceipts ? "photo" : "text"), [config.aiReceipts]);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  if (haul.loading) return <Loading />;
  if (haul.error || !haul.data) return <ErrorState message={haul.error?.message ?? "Couldn't load."} />;
  const detail = haul.data;

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    const next: Photo[] = [];
    for (const file of Array.from(files).slice(0, 6 - photos.length)) {
      const blob = await shrink(file);
      next.push({ blob, url: URL.createObjectURL(blob) });
    }
    setPhotos((p) => [...p, ...next]);
  }

  async function read() {
    setReading(true);
    setError("");
    try {
      let res: ReceiptResult;
      if (mode === "photo") {
        const form = new FormData();
        photos.forEach((p, i) => form.append("images", p.blob, `receipt-${i + 1}.jpg`));
        res = await api<ReceiptResult>("POST", `/hauls/${id}/receipt`, form);
      } else {
        res = await api<ReceiptResult>("POST", `/hauls/${id}/receipt`, { text });
      }
      setResult(res);
      setRows(
        res.items.map((i) => ({
          include: true,
          name: i.name,
          rawName: i.rawName,
          itemNumber: i.itemNumber,
          discountCents: i.discountCents,
          price: (i.priceCents / 100).toFixed(2),
          quantity: String(i.quantity),
          unit: i.unit,
          shares: String(i.shares),
          taxable: i.taxable,
          expiresOn: "",
        })),
      );
      setApplyTax((res.taxCents ?? 0) > 0);
      setApplyDate(!!res.purchaseDate && res.purchaseDate !== detail.haul.purchasedOn);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReading(false);
    }
  }

  function update(index: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  const included = rows.filter((r) => r.include);
  const invalid = included.filter((r) => !r.name.trim() || parseDollars(r.price) === null || !(Number(r.quantity) > 0) || !(Number(r.shares) >= 1));
  const includedCents = included.reduce((s, r) => s + (parseDollars(r.price) ?? 0), 0);
  const taxableCents = (result?.items ?? []).filter((i) => i.taxable).reduce((s, i) => s + i.priceCents, 0);
  const taxRate = result?.taxCents ? taxRateFromReceipt(result.taxCents, taxableCents) : 0;

  async function save() {
    setSaving(true);
    setError("");
    try {
      await api("POST", `/hauls/${id}/items`, {
        items: included.map((r) => ({
          name: r.name.trim(),
          itemNumber: r.itemNumber,
          priceCents: parseDollars(r.price)!,
          quantity: Number(r.quantity),
          unit: r.unit,
          shares: Math.round(Number(r.shares)),
          taxable: r.taxable,
          expiresOn: r.expiresOn || null,
          notes: r.discountCents ? `Instant savings ${formatCents(r.discountCents)}` : null,
        })),
      });
      const patch: Record<string, unknown> = {};
      if (applyTax && taxRate > 0) patch.taxRate = taxRate;
      if (applyDate && result?.purchaseDate) patch.purchasedOn = result.purchaseDate;
      if (Object.keys(patch).length) await api("PATCH", `/hauls/${id}`, patch);
      navigate(`/h/${id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------- review step
  if (result) {
    const today = todayISO();
    return (
      <>
        <TopBar back={`/h/${id}`} title="Check the items" />
        <main className="page has-bottom-bar">
          <section className="stack" style={{ gap: 6 }}>
            <h1>
              Found {result.items.length} item{result.items.length === 1 ? "" : "s"}
            </h1>
            <p className="small muted">
              Untick anything you're keeping to yourself, and check the sizes and portions. You can change all of this later too.
            </p>
          </section>

          {result.warnings.length > 0 && (
            <div className="card warn stack" style={{ gap: 6 }}>
              {result.warnings.map((w) => (
                <p key={w} className="small row" style={{ alignItems: "flex-start", gap: 8 }}>
                  <span style={{ flexShrink: 0, marginTop: 2 }}>
                    <Icon name="alert" size={16} />
                  </span>
                  {w}
                </p>
              ))}
            </div>
          )}

          <div className="card stack" style={{ gap: 10 }}>
            {result.subtotalCents != null && (
              <div className="row-between small">
                <span className="muted">Receipt subtotal</span>
                <span className="num">{formatCents(result.subtotalCents)}</span>
              </div>
            )}
            {result.taxCents != null && result.taxCents > 0 && (
              <label className="check small">
                <input type="checkbox" checked={applyTax} onChange={(e) => setApplyTax(e.target.checked)} />
                <span>
                  Tax {formatCents(result.taxCents)}
                  {taxRate > 0 ? (
                    <>
                      {" "}
                      → set the haul's tax to <b>{taxRate}%</b> on taxed items
                    </>
                  ) : (
                    " — tick the taxed items below so it can be shared"
                  )}
                </span>
              </label>
            )}
            {result.purchaseDate && result.purchaseDate !== detail.haul.purchasedOn && (
              <label className="check small">
                <input type="checkbox" checked={applyDate} onChange={(e) => setApplyDate(e.target.checked)} />
                <span>Set the haul date to {formatDate(result.purchaseDate)}</span>
              </label>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: true })))}>
                Select all
              </button>
              <button className="btn sm" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: false })))}>
                Select none
              </button>
            </div>
          </div>

          <div className="list">
            {rows.map((r, i) => {
              const priceCents = parseDollars(r.price);
              const qty = Number(r.quantity);
              return (
                <div key={i} className={`card tight receipt-line${r.include ? "" : " off"}`}>
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) => update(i, { include: e.target.checked })}
                    aria-label={`Include ${r.name}`}
                    style={{ width: 22, height: 22, marginTop: 2, accentColor: "var(--primary)", flexShrink: 0 }}
                  />
                  <div className="grow stack" style={{ gap: 4 }}>
                    <div className="row-between" style={{ alignItems: "flex-start" }}>
                      <p className="strong grow">{r.name || <span className="muted">Unnamed</span>}</p>
                      <span className="strong num">{priceCents != null ? formatCents(priceCents) : "?"}</span>
                    </div>
                    <p className="receipt-raw">
                      {r.rawName}
                      {r.itemNumber ? ` · #${r.itemNumber}` : ""}
                      {r.discountCents ? ` · saved ${formatCents(r.discountCents)}` : ""}
                    </p>
                    <div className="row-between">
                      <span className="small muted">
                        {qty > 0 ? formatQuantity(qty, r.unit) : "?"} · {r.shares} portion{r.shares === "1" ? "" : "s"}
                        {r.taxable ? " · taxed" : ""}
                        {r.expiresOn ? ` · use by ${formatDate(r.expiresOn)}` : ""}
                      </span>
                      <button className="link-btn small" onClick={() => setOpen(open === i ? null : i)}>
                        {open === i ? "Done" : "Edit"}
                      </button>
                    </div>
                    {open === i && (
                      <div className="stack" style={{ marginTop: 8 }}>
                        <input className="input" value={r.name} onChange={(e) => update(i, { name: e.target.value })} aria-label="Name" maxLength={120} />
                        <div className="grid-2">
                          <div className="input-prefix">
                            <span>$</span>
                            <input className="input num" inputMode="decimal" value={r.price} onChange={(e) => update(i, { price: e.target.value })} aria-label="Price" />
                          </div>
                          <div className="row" style={{ gap: 6 }}>
                            <input
                              className="input num"
                              inputMode="decimal"
                              value={r.quantity}
                              aria-label="Quantity"
                              style={{ minWidth: 0 }}
                              onChange={(e) => {
                                const q = Number(e.target.value);
                                update(i, { quantity: e.target.value, ...(q > 0 ? { shares: String(defaultShares(q, r.unit)) } : {}) });
                              }}
                            />
                            <select
                              className="input"
                              value={r.unit}
                              aria-label="Unit"
                              style={{ width: 92, flexShrink: 0 }}
                              onChange={(e) => {
                                const unit = e.target.value as Unit;
                                update(i, { unit, ...(qty > 0 ? { shares: String(defaultShares(qty, unit)) } : {}) });
                              }}
                            >
                              {UNITS.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.plural}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="field">
                          <span className="label">Portions</span>
                          <div className="row">
                            <input
                              className="input num"
                              inputMode="numeric"
                              value={r.shares}
                              aria-label="Portions"
                              style={{ width: 80 }}
                              onChange={(e) => update(i, { shares: e.target.value.replace(/\D/g, "") })}
                            />
                            {qty > 0 && (
                              <div className="chips grow">
                                {portionChoices(qty, r.unit).map((c) => (
                                  <button key={c.label} className={`chip${String(c.shares) === r.shares ? " on" : ""}`} onClick={() => update(i, { shares: String(c.shares) })}>
                                    {c.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="chips">
                          <span className="small muted" style={{ alignSelf: "center" }}>
                            Use by:
                          </span>
                          {(
                            [
                              ["3 days", 3],
                              ["1 week", 7],
                              ["2 weeks", 14],
                              ["1 month", 30],
                            ] as const
                          ).map(([label, days]) => {
                            const value = addDays(today, days);
                            return (
                              <button key={label} className={`chip${r.expiresOn === value ? " on" : ""}`} onClick={() => update(i, { expiresOn: value })}>
                                {label}
                              </button>
                            );
                          })}
                          {r.expiresOn && (
                            <button className="chip" onClick={() => update(i, { expiresOn: "" })}>
                              None
                            </button>
                          )}
                        </div>
                        <label className="check small">
                          <input type="checkbox" checked={r.taxable} onChange={(e) => update(i, { taxable: e.target.checked })} />
                          Taxed item
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {error && <p className="error-text">{error}</p>}
        </main>
        <div className="bottom-bar">
          <div className="bottom-bar-inner">
            <div className="grow">
              <p className="tiny muted">{included.length} selected</p>
              <p className="total-big">{formatCents(includedCents)}</p>
            </div>
            <button className="btn ghost" onClick={() => setResult(null)}>
              Back
            </button>
            <button className="btn primary lg" disabled={saving || included.length === 0 || invalid.length > 0} onClick={save}>
              {saving ? <span className="spinner" /> : invalid.length ? "Fix items" : `Add ${included.length}`}
            </button>
          </div>
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------- input step
  return (
    <>
      <TopBar back={`/h/${id}`} title="Scan receipt" />
      <main className="page">
        <section className="stack" style={{ gap: 6 }}>
          <h1>Add items from your receipt</h1>
          <p className="small muted">We'll pull out every line, merge instant savings and work out the tax. You review it before anything is added.</p>
        </section>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === "photo"} className={`tab${mode === "photo" ? " on" : ""}`} onClick={() => setMode("photo")}>
            <Icon name="camera" size={16} /> Photo
          </button>
          <button role="tab" aria-selected={mode === "text"} className={`tab${mode === "text" ? " on" : ""}`} onClick={() => setMode("text")}>
            <Icon name="receipt" size={16} /> Paste text
          </button>
        </div>

        {mode === "photo" ? (
          config.aiReceipts ? (
            <div className="stack">
              <label className="btn primary lg block" style={{ cursor: "pointer" }}>
                <Icon name="camera" /> {photos.length ? "Add another photo" : "Take or choose a photo"}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="visually-hidden"
                  onChange={(e) => {
                    void addPhotos(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
              {photos.length > 0 && (
                <div className="thumbs">
                  {photos.map((p, i) => (
                    <div key={p.url} className="thumb">
                      <img src={p.url} alt={`Receipt photo ${i + 1}`} />
                      <button aria-label="Remove photo" onClick={() => {
                          URL.revokeObjectURL(p.url);
                          setPhotos((ps) => ps.filter((_, j) => j !== i));
                        }}>
                        <Icon name="x" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="card flat stack small" style={{ gap: 6 }}>
                <p className="strong">Tips for a good scan</p>
                <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Lay the receipt flat in good light.</li>
                  <li>Long receipt? Take 2–3 photos top to bottom, overlapping a little.</li>
                  <li>A screenshot of the digital receipt in the Costco app works great too.</li>
                </ul>
              </div>
              {error && <p className="error-text">{error}</p>}
              <button className="btn primary lg block" disabled={reading || photos.length === 0} onClick={read}>
                {reading ? (
                  <>
                    <span className="spinner" /> Reading your receipt…
                  </>
                ) : (
                  `Read ${photos.length > 1 ? `${photos.length} photos` : "receipt"}`
                )}
              </button>
              {reading && <p className="small muted" style={{ textAlign: "center" }}>This can take up to a minute for a long receipt.</p>}
            </div>
          ) : (
            <div className="card warn stack" style={{ gap: 8 }}>
              <p className="strong">Photo scanning isn't turned on for this app yet.</p>
              <p className="small">
                Whoever runs it can enable it by adding an Anthropic API key (see the README). Meanwhile, copy the text out of your
                receipt photo and paste it — it works almost as well.
              </p>
              <button className="btn" onClick={() => setMode("text")}>
                Paste text instead
              </button>
            </div>
          )
        ) : (
          <div className="stack">
            <textarea
              className="input"
              style={{ minHeight: 220, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14 }}
              placeholder={"E  1234567 KS CHKN BRST   21.99 N\nE  512515 KS ORG EGGS 24CT  8.49 N\n   SUBTOTAL  30.48\n   TAX  0.00"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Receipt text"
            />
            <div className="card flat small stack" style={{ gap: 6 }}>
              <p className="strong">Getting the text off a photo</p>
              <p className="muted">
                <b>iPhone:</b> open the photo, press and hold on the text, tap <i>Select All</i>, then <i>Copy</i>.{" "}
                <b>Android:</b> open the photo in Google Photos, tap <i>Lens</i> → <i>Text</i> → <i>Select all</i> → <i>Copy</i>.
              </p>
            </div>
            {error && <p className="error-text">{error}</p>}
            <button className="btn primary lg block" disabled={reading || !text.trim()} onClick={read}>
              {reading ? <span className="spinner" /> : "Read text"}
            </button>
          </div>
        )}
      </main>
    </>
  );
}
