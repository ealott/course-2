import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { HaulDetail } from "../../shared/api";
import { centsToPlain, formatCents } from "../../shared/money";
import { computeTotals, settlementState } from "../../shared/split";
import { portionLabel } from "../../shared/units";
import { api, useApi } from "../api";
import { formatDate } from "../dates";
import { CopyButton, ErrorState, ExpiryBadge, Icon, Loading, Money, TopBar, errorMessage, useToast } from "../ui";

export function Checkout() {
  const { id = "" } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<HaulDetail>(`/hauls/${id}`, { poll: 15_000 });
  const [busy, setBusy] = useState(false);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorState message={error?.message ?? "Couldn't load."} onRetry={reload} />;
  if (data.isOrganizer) return <Navigate to={`/h/${id}`} replace />;

  const { haul, meId } = data;
  const totals = computeTotals(data.items, haul.taxRate);
  const mine = totals.people[meId];
  const total = mine?.totalCents ?? 0;
  const settlement = data.settlements.find((s) => s.userId === meId);
  const state = settlementState(total, settlement);
  const confirmed = !!settlement?.confirmedAt || haul.status === "closed";
  const itemById = Object.fromEntries(data.items.map((i) => [i.id, i]));
  const hasExpiry = (mine?.lines ?? []).some((l) => itemById[l.itemId]?.expiresOn);
  const memo = `HaulSplit: ${haul.title}`.slice(0, 60);
  const zelle = haul.organizer.zelle;
  const organizer = haul.organizer.name;

  async function act(action: string, done: string) {
    setBusy(true);
    try {
      await api("PUT", `/hauls/${haul.id}/settlements/${meId}`, { action });
      toast(done);
      await reload();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  }

  const amountDue = state.kind === "owes" ? state.owedCents : state.kind === "selecting" ? total : 0;

  return (
    <>
      <TopBar back={`/h/${haul.id}`} title="Your share" />
      <main className="page">
        <section className="stack" style={{ gap: 4 }}>
          <p className="muted small">
            {haul.title}
            {haul.purchasedOn ? ` · ${formatDate(haul.purchasedOn)}` : ""}
          </p>
          <h1>Your share</h1>
        </section>

        <div className="card stack" style={{ gap: 10 }}>
          {(mine?.lines ?? []).map((line) => {
            const item = itemById[line.itemId];
            if (!item) return null;
            return (
              <div key={line.itemId} className="row-between" style={{ alignItems: "flex-start" }}>
                <div className="grow">
                  <p className="strong">{item.name}</p>
                  <p className="small muted">
                    {item.shares > 1 ? `${line.shares} × ${portionLabel(item.quantity, item.unit, item.shares)}` : "Whole item"}
                    {item.taxable && haul.taxRate > 0 ? " · incl. tax" : ""}
                  </p>
                  {item.expiresOn && (
                    <div style={{ marginTop: 4 }}>
                      <ExpiryBadge date={item.expiresOn} />
                    </div>
                  )}
                </div>
                <Money cents={line.cents} className="strong" />
              </div>
            );
          })}
          {!mine && <p className="muted">You haven't picked anything from this haul.</p>}
          <div className="divider" />
          <div className="row-between">
            <span className="strong">Total</span>
            <Money cents={total} className="total-big" />
          </div>
        </div>

        {total > 0 && !confirmed && state.kind === "selecting" && (
          <div className="stack">
            <button className="btn primary lg block" disabled={busy} onClick={() => act("confirm", "Order confirmed")}>
              <Icon name="check" size={18} /> That's everything
            </button>
            <Link to={`/h/${haul.id}`} className="btn ghost block">
              Keep picking
            </Link>
          </div>
        )}

        {(confirmed || state.kind !== "selecting") && state.kind !== "none" && (
          <section className={`card stack ${state.kind === "paid" ? "" : "tinted"}`}>
            {state.kind === "paid" ? (
              <div className="stack" style={{ alignItems: "center", textAlign: "center", gap: 6 }}>
                <div className="empty-icon" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
                  <Icon name="check" size={28} />
                </div>
                <h2>All paid up</h2>
                <p className="muted small">{organizer} confirmed your {formatCents(total)}. Enjoy the haul!</p>
              </div>
            ) : state.kind === "sent" ? (
              <div className="stack" style={{ gap: 8 }}>
                <h2>Marked as sent</h2>
                <p className="small">
                  You told {organizer} you sent <b>{formatCents(state.paidCents)}</b>. They'll confirm once it shows up.
                </p>
                <button className="link-btn small" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => act("unsent", "Undone")}>
                  I haven't actually sent it yet
                </button>
              </div>
            ) : state.kind === "refund" ? (
              <div className="stack" style={{ gap: 8 }}>
                <h2>You overpaid</h2>
                <p className="small">
                  Your picks changed after you paid. {organizer} owes you <b>{formatCents(state.refundCents)}</b> back.
                </p>
              </div>
            ) : (
              <>
                <div>
                  <p className="small muted">{state.kind === "owes" && state.paidCents > 0 ? "Your total changed. Send the difference:" : "Send with Zelle"}</p>
                  <p className="amount-hero">{formatCents(amountDue)}</p>
                  <p className="small">
                    to <b>{organizer}</b>
                  </p>
                </div>
                {zelle ? (
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="copy-row">
                      <span className="small muted" style={{ width: 62 }}>
                        Zelle
                      </span>
                      <span className="value">{zelle}</span>
                      <CopyButton text={zelle} what="Zelle address" />
                    </div>
                    <div className="copy-row">
                      <span className="small muted" style={{ width: 62 }}>
                        Amount
                      </span>
                      <span className="value num">{formatCents(amountDue)}</span>
                      <CopyButton text={centsToPlain(amountDue)} what="Amount" />
                    </div>
                    <div className="copy-row">
                      <span className="small muted" style={{ width: 62 }}>
                        Memo
                      </span>
                      <span className="value small">{memo}</span>
                      <CopyButton text={memo} what="Memo" />
                    </div>
                  </div>
                ) : (
                  <p className="small">{organizer} hasn't added their Zelle email or phone yet — ask them where to send it.</p>
                )}
                <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Open your bank's app and choose Zelle.</li>
                  <li>Paste {organizer}'s Zelle address and the amount.</li>
                  <li>Come back and tap the button below.</li>
                </ol>
                <button className="btn primary lg block" disabled={busy} onClick={() => act("sent", "Thanks! Marked as sent")}>
                  I sent {formatCents(amountDue)}
                </button>
                {haul.status === "open" && state.kind === "owes" && state.paidCents === 0 && (
                  <button className="btn ghost block" disabled={busy} onClick={() => act("unconfirm", "OK — keep picking")}>
                    Wait, I want to change my picks
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {haul.pickup && (
          <div className="card flat stack" style={{ gap: 6 }}>
            <p className="row strong small" style={{ gap: 6 }}>
              <Icon name="pin" size={16} /> Pickup
            </p>
            <p className="small" style={{ whiteSpace: "pre-wrap" }}>
              {haul.pickup}
            </p>
          </div>
        )}

        {hasExpiry && (
          <a className="btn block" href={`/api/hauls/${haul.id}/expirations.ics`}>
            <Icon name="calendar" size={18} /> Add use-by reminders to my calendar
          </a>
        )}
      </main>
    </>
  );
}
