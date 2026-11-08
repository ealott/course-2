import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { HaulDetail, HaulStatus, Item, ItemInput } from "../../shared/api";
import { formatCents } from "../../shared/money";
import { claimedShares, computeTotals, lineCents, settlementState, type HaulTotals, type SettlementState } from "../../shared/split";
import { UNITS, formatQuantity, portionLabel } from "../../shared/units";
import { api, useApi } from "../api";
import { ItemForm } from "../components/ItemForm";
import { formatDate } from "../dates";
import { useSession } from "../session";
import { Avatar, Empty, ErrorState, ExpiryBadge, Icon, Loading, Money, Sheet, Stepper, TopBar, errorMessage, useShare, useToast } from "../ui";

const STATUS_LABEL: Record<HaulStatus, string> = { draft: "Draft", open: "Open for picks", closed: "Picks closed" };

function applyPending(items: Item[], pending: Record<string, number>): Item[] {
  if (Object.keys(pending).length === 0) return items;
  return items.map((item) => {
    const mine = Object.entries(pending).filter(([key]) => key.startsWith(`${item.id}:`));
    if (mine.length === 0) return item;
    let claims = [...item.claims];
    for (const [key, shares] of mine) {
      const userId = key.slice(item.id.length + 1);
      const existing = claims.findIndex((c) => c.userId === userId);
      if (shares <= 0) claims = claims.filter((c) => c.userId !== userId);
      else if (existing >= 0) claims[existing] = { userId, shares };
      else claims.push({ userId, shares });
    }
    return { ...item, claims };
  });
}

export function HaulPage() {
  const { id = "" } = useParams();
  const { config } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const share = useShare();
  const [pending, setPending] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, number>>({});
  const { data, error, loading, reload, setData } = useApi<HaulDetail>(`/hauls/${id}`, {
    poll: 8000,
    paused: Object.keys(pending).length > 0,
  });
  const [tab, setTab] = useState<"items" | "people">("items");
  const [filter, setFilter] = useState<"all" | "available" | "mine">("all");
  const [editing, setEditing] = useState<Item | "new" | "scan" | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => () => Object.values(timers.current).forEach((t) => window.clearTimeout(t)), []);

  const items = useMemo(() => (data ? applyPending(data.items, pending) : []), [data, pending]);
  const totals = useMemo(() => computeTotals(items, data?.haul.taxRate ?? 0), [items, data?.haul.taxRate]);

  const setClaim = useCallback(
    (itemId: string, userId: string, shares: number) => {
      const key = `${itemId}:${userId}`;
      setPending((p) => ({ ...p, [key]: shares }));
      window.clearTimeout(timers.current[key]);
      timers.current[key] = window.setTimeout(async () => {
        try {
          const res = await api<{ item: Item }>("PUT", `/items/${itemId}/claims/${userId}`, { shares });
          setData((d) => (d ? { ...d, items: d.items.map((i) => (i.id === itemId ? res.item : i)) } : d));
        } catch (err) {
          toast(errorMessage(err), { error: true });
        } finally {
          setPending((p) => {
            if (p[key] !== shares) return p; // a newer tap is on its way
            const { [key]: _, ...rest } = p;
            return rest;
          });
          void reload();
        }
      }, 350);
    },
    [reload, setData, toast],
  );

  if (loading) return <Loading />;
  if (error || !data) {
    return (
      <>
        <TopBar back="/" />
        <ErrorState
          message={
            error?.status === 404
              ? "This haul doesn't exist, or you're not in its group yet. Ask the organizer for the group's invite link."
              : (error?.message ?? "Couldn't load this haul.")
          }
          onRetry={error?.status === 404 ? undefined : reload}
        />
      </>
    );
  }

  const { haul, meId, isOrganizer, members } = data;
  const names = Object.fromEntries(members.map((m) => [m.id, m.id === meId ? "You" : m.name]));
  const myTotal = totals.people[meId]?.totalCents ?? 0;
  const mySettlement = data.settlements.find((s) => s.userId === meId);
  const myState = settlementState(myTotal, mySettlement, isOrganizer);
  const canPick = isOrganizer || haul.status === "open";
  const haulUrl = `${window.location.origin}/h/${haul.id}`;

  async function saveHaul(patch: Record<string, unknown>, done?: string) {
    try {
      await api("PATCH", `/hauls/${haul.id}`, patch);
      if (done) toast(done);
      await reload();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  }

  async function shareWithGroup() {
    if (haul.status === "draft") {
      if (items.length === 0 && !window.confirm("There are no items yet. Share anyway?")) return;
      await saveHaul({ status: "open" }, `Shared with ${haul.groupName}`);
    }
    await share({ title: haul.title, text: `Pick what you want from ${haul.title}:`, url: haulUrl });
  }

  async function saveItem(input: ItemInput, addAnother: boolean) {
    if (editing && typeof editing !== "string") {
      await api("PATCH", `/items/${editing.id}`, input);
      toast("Saved");
    } else {
      await api("POST", `/hauls/${haul.id}/items`, { items: [input] });
      toast(`Added ${input.name}`);
    }
    await reload();
    if (!addAnother) setEditing(null);
  }

  const visible = items.filter((item) => {
    if (filter === "mine") return item.claims.some((c) => c.userId === meId);
    if (filter === "available") return claimedShares(item) < item.shares;
    return true;
  });
  const myItemCount = items.filter((i) => i.claims.some((c) => c.userId === meId)).length;
  const assigningItem = assigning ? items.find((i) => i.id === assigning) : null;

  return (
    <>
      <TopBar
        back="/"
        title={haul.title}
        right={
          isOrganizer ? (
            <button className="icon-btn" aria-label="Haul settings" onClick={() => setSettingsOpen(true)}>
              <Icon name="settings" />
            </button>
          ) : null
        }
      />
      <main className="page has-bottom-bar">
        <section className="stack" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className={`badge ${haul.status === "open" ? "primary" : haul.status === "draft" ? "warn" : ""}`}>
              {haul.status === "closed" && <Icon name="lock" size={12} strokeWidth={2.5} />}
              {STATUS_LABEL[haul.status]}
            </span>
            <span className="small muted">
              {haul.groupName} · {isOrganizer ? "you organized" : `organized by ${haul.organizer.name}`}
              {haul.purchasedOn ? ` · ${formatDate(haul.purchasedOn)}` : ""}
            </span>
          </div>
          <h1>{haul.title}</h1>
          {haul.pickup && (
            <p className="row small" style={{ alignItems: "flex-start", gap: 6 }}>
              <span style={{ color: "var(--primary)", marginTop: 1 }}>
                <Icon name="pin" size={16} />
              </span>
              <span style={{ whiteSpace: "pre-wrap" }}>{haul.pickup}</span>
            </p>
          )}
        </section>

        {isOrganizer && haul.status === "draft" && (
          <div className="card warn stack" style={{ gap: 8 }}>
            <p className="strong">Only you can see this haul.</p>
            <p className="small">Add what you bought, then share it with {haul.groupName} so people can pick their portions.</p>
          </div>
        )}

        {isOrganizer && (
          <div className="actions">
            <Link to={`/h/${haul.id}/import`} className="action-tile">
              <Icon name="receipt" size={24} />
              Scan receipt
            </Link>
            <button className="action-tile" onClick={() => setEditing("scan")}>
              <Icon name="barcode" size={24} />
              Scan barcode
            </button>
            <button className="action-tile" onClick={() => setEditing("new")}>
              <Icon name="plus" size={24} />
              Type it in
            </button>
          </div>
        )}

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "items"} className={`tab${tab === "items" ? " on" : ""}`} onClick={() => setTab("items")}>
            Items · {items.length}
          </button>
          <button role="tab" aria-selected={tab === "people"} className={`tab${tab === "people" ? " on" : ""}`} onClick={() => setTab("people")}>
            People · {Object.keys(totals.people).length}
          </button>
        </div>

        {tab === "items" ? (
          items.length === 0 ? (
            <Empty icon="bag" title={isOrganizer ? "Add what you bought" : "No items yet"}>
              <p className="muted small">
                {isOrganizer
                  ? config.aiReceipts
                    ? "Snap a photo of the receipt and everything gets added at once, or scan barcodes one at a time."
                    : "Paste your receipt text, scan barcodes, or type items in."
                  : `${haul.organizer.name} hasn't added anything yet. Check back soon.`}
              </p>
            </Empty>
          ) : (
            <>
              <div className="chips" role="radiogroup" aria-label="Filter items">
                {(
                  [
                    ["all", "All"],
                    ["available", "Still available"],
                    ["mine", `My picks${myItemCount ? ` · ${myItemCount}` : ""}`],
                  ] as const
                ).map(([key, label]) => (
                  <button key={key} role="radio" aria-checked={filter === key} className={`chip${filter === key ? " on" : ""}`} onClick={() => setFilter(key)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="list">
                {visible.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    taxRate={haul.taxRate}
                    meId={meId}
                    names={names}
                    canPick={canPick}
                    isOrganizer={isOrganizer}
                    onClaim={(shares) => setClaim(item.id, meId, shares)}
                    onEdit={() => setEditing(item)}
                    onAssign={() => setAssigning(item.id)}
                  />
                ))}
                {visible.length === 0 && <p className="muted small" style={{ textAlign: "center", padding: 20 }}>Nothing here.</p>}
              </div>
              {!canPick && !isOrganizer && (
                <p className="small muted row" style={{ justifyContent: "center" }}>
                  <Icon name="lock" size={14} /> Picks are closed. Ask {haul.organizer.name} if you need a change.
                </p>
              )}
            </>
          )
        ) : (
          <PeopleTab data={data} items={items} totals={totals} names={names} onChanged={reload} onStatus={(s) => saveHaul({ status: s })} />
        )}
      </main>

      <BottomBar
        data={data}
        myTotal={myTotal}
        myItemCount={myItemCount}
        myState={myState}
        totals={totals}
        onShare={shareWithGroup}
        onPay={() => navigate(`/h/${haul.id}/pay`)}
        onPeople={() => setTab("people")}
      />

      {editing && (
        <ItemForm
          groupId={haul.groupId}
          taxRate={haul.taxRate}
          item={typeof editing === "string" ? undefined : editing}
          claimed={typeof editing === "string" ? 0 : claimedShares(editing)}
          autoScan={editing === "scan"}
          onClose={() => setEditing(null)}
          onSave={saveItem}
          onDelete={
            typeof editing === "string"
              ? undefined
              : async () => {
                  await api("DELETE", `/items/${editing.id}`);
                  toast("Deleted");
                  setEditing(null);
                  await reload();
                }
          }
        />
      )}
      {assigningItem && (
        <AssignSheet item={assigningItem} data={data} names={names} onClaim={setClaim} onClose={() => setAssigning(null)} />
      )}
      {settingsOpen && (
        <HaulSettings
          data={data}
          onClose={() => setSettingsOpen(false)}
          onSave={async (patch) => {
            await saveHaul(patch, "Saved");
            setSettingsOpen(false);
          }}
          onDelete={async () => {
            await api("DELETE", `/hauls/${haul.id}`);
            toast("Haul deleted");
            navigate("/", { replace: true });
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ item card

/** "8 lb · $2.75 per lb", "24 ct · $0.35 each", "6.3 lb · 6 portions of ~1.05 lb · $3.67 each" */
function describeSplit(item: Item, each: number, taxRate: number): string {
  const size = formatQuantity(item.quantity, item.unit);
  const price = formatCents(each);
  const tax = item.taxable && taxRate > 0 ? " incl. tax" : "";
  if (item.shares === 1) return `${size} · sold whole${tax}`;
  const unitDef = UNITS.find((u) => u.id === item.unit);
  if (Math.abs(item.quantity / item.shares - 1) < 1e-9 && unitDef) {
    const per = ["ct", "item"].includes(item.unit) ? "each" : `per ${unitDef.singular}`;
    return `${size} · ${price} ${per}${tax}`;
  }
  return `${size} · ${item.shares} portions of ${portionLabel(item.quantity, item.unit, item.shares)} · ${price} each${tax}`;
}

function ItemCard({
  item,
  taxRate,
  meId,
  names,
  canPick,
  isOrganizer,
  onClaim,
  onEdit,
  onAssign,
}: {
  item: Item;
  taxRate: number;
  meId: string;
  names: Record<string, string>;
  canPick: boolean;
  isOrganizer: boolean;
  onClaim: (shares: number) => void;
  onEdit: () => void;
  onAssign: () => void;
}) {
  const mine = item.claims.find((c) => c.userId === meId)?.shares ?? 0;
  const taken = claimedShares(item);
  const left = item.shares - taken;
  const others = taken - mine;
  const each = lineCents(item, 1, taxRate);
  const single = item.shares === 1;

  return (
    <article className={`card item-card${mine > 0 ? " mine" : ""}`} aria-label={item.name}>
      <div className="item-head">
        <div className="grow stack" style={{ gap: 3 }}>
          <h3 className="item-name">{item.name}</h3>
          <p className="item-meta">{describeSplit(item, each, taxRate)}</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <Money cents={item.priceCents} className="item-price" />
          {isOrganizer && (
            <div>
              <button className="icon-btn sm" aria-label={`Edit ${item.name}`} onClick={onEdit} style={{ marginRight: -8 }}>
                <Icon name="edit" size={18} />
              </button>
            </div>
          )}
        </div>
      </div>

      {(item.expiresOn || item.notes) && (
        <div className="row wrap" style={{ gap: 6 }}>
          {item.expiresOn && <ExpiryBadge date={item.expiresOn} />}
          {item.notes && <span className="small muted">{item.notes}</span>}
        </div>
      )}

      <div className="stack" style={{ gap: 6 }}>
        <div className="progress" aria-hidden="true">
          <span className="mine" style={{ width: `${(mine / item.shares) * 100}%` }} />
          <span style={{ width: `${(others / item.shares) * 100}%` }} />
        </div>
        <div className="row-between small">
          <span className="claimants">
            {item.claims.length === 0
              ? "Nobody yet"
              : item.claims.map((c) => (
                  <span key={c.userId}>
                    <b>{names[c.userId] ?? "Someone"}</b> {c.shares}
                  </span>
                ))}
          </span>
          <span className={`strong ${left === 0 ? "muted" : ""}`} style={{ whiteSpace: "nowrap" }}>
            {left === 0 ? "All taken" : `${left} left`}
          </span>
        </div>
      </div>

      {isOrganizer && (
        <button className="link-btn small row" style={{ gap: 4, alignSelf: "flex-start" }} onClick={onAssign}>
          <Icon name="users" size={16} /> Pick for someone else
        </button>
      )}
      <div className="divider" />
      <div className="row-between">
        <div>
          <p className="small strong">{single ? "Whole item" : "Yours"}</p>
          <p className="small muted num">{mine > 0 ? formatCents(lineCents(item, mine, taxRate)) : "—"}</p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {canPick &&
            (single ? (
              <button
                className={`btn sm ${mine ? "primary" : ""}`}
                disabled={!mine && left === 0}
                onClick={() => onClaim(mine ? 0 : 1)}
                aria-pressed={mine > 0}
              >
                {mine ? (
                  <>
                    <Icon name="check" size={16} /> Mine
                  </>
                ) : (
                  "Take it"
                )}
              </button>
            ) : (
              <Stepper value={mine} max={mine + left} onChange={onClaim} label={`portions of ${item.name}`} />
            ))}
          {!canPick && <span className="badge">{mine} taken</span>}
        </div>
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ organizer picks for others

function AssignSheet({
  item,
  data,
  names,
  onClaim,
  onClose,
}: {
  item: Item;
  data: HaulDetail;
  names: Record<string, string>;
  onClaim: (itemId: string, userId: string, shares: number) => void;
  onClose: () => void;
}) {
  const left = item.shares - claimedShares(item);
  return (
    <Sheet title={item.name} onClose={onClose}>
      <div className="stack">
        <p className="small muted">
          Pick portions for anyone in the group — handy for people who texted you their order. {left} of {item.shares} left.
        </p>
        <div className="list-rows">
          {data.members.map((m) => {
            const shares = item.claims.find((c) => c.userId === m.id)?.shares ?? 0;
            return (
              <div key={m.id} className="list-row">
                <Avatar name={m.name} small />
                <span className="grow strong">{names[m.id]}</span>
                <span className="small muted num">{shares ? formatCents(lineCents(item, shares, data.haul.taxRate)) : ""}</span>
                <Stepper value={shares} max={shares + left} onChange={(v) => onClaim(item.id, m.id, v)} label={`portions for ${m.name}`} />
              </div>
            );
          })}
        </div>
        <button className="btn primary block" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ people & payments

function stateBadge(state: SettlementState, organizerName: string): { text: string; tone: string } {
  switch (state.kind) {
    case "none":
      return { text: "Nothing yet", tone: "" };
    case "selecting":
      return { text: "Still picking", tone: "" };
    case "owes":
      return { text: state.paidCents ? `Owes ${formatCents(state.owedCents)} more` : `Owes ${formatCents(state.owedCents)}`, tone: "warn" };
    case "sent":
      return { text: `Says they sent ${formatCents(state.paidCents)}`, tone: "primary" };
    case "paid":
      return { text: "Paid", tone: "ok" };
    case "refund":
      return { text: `${organizerName} owes them ${formatCents(state.refundCents)}`, tone: "danger" };
  }
}

function PeopleTab({
  data,
  items,
  totals,
  names,
  onChanged,
  onStatus,
}: {
  data: HaulDetail;
  items: Item[];
  totals: HaulTotals;
  names: Record<string, string>;
  onChanged: () => Promise<void>;
  onStatus: (status: HaulStatus) => Promise<void>;
}) {
  const toast = useToast();
  const { haul, isOrganizer, meId } = data;
  const organizerId = haul.organizer.id;
  const ids = new Set<string>([organizerId, ...Object.keys(totals.people), ...data.settlements.filter((s) => s.paidCents > 0).map((s) => s.userId)]);
  const people = [...ids].sort((a, b) => (a === organizerId ? -1 : b === organizerId ? 1 : (names[a] ?? "").localeCompare(names[b] ?? "")));
  const notPicked = data.members.filter((m) => !ids.has(m.id));
  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
  const owedToOrganizer = people.filter((p) => p !== organizerId).reduce((s, p) => s + (totals.people[p]?.totalCents ?? 0), 0);
  const collected = data.settlements.filter((s) => s.userId !== organizerId).reduce((s, x) => s + x.verifiedCents, 0);
  const taxCents = totals.haulCents - items.reduce((s, i) => s + i.priceCents, 0);

  async function settle(userId: string, action: string, done: string) {
    try {
      await api("PUT", `/hauls/${haul.id}/settlements/${userId}`, { action });
      toast(done);
      await onChanged();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  }

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 8 }}>
        <div className="row-between">
          <span className="muted">Haul total{taxCents > 0 ? ` (incl. ${formatCents(taxCents)} tax)` : ""}</span>
          <Money cents={totals.haulCents} className="strong" />
        </div>
        <div className="row-between">
          <span className="muted">Picked by others</span>
          <Money cents={owedToOrganizer} />
        </div>
        <div className="row-between">
          <span className="muted">Not picked yet · stays with {isOrganizer ? "you" : haul.organizer.name}</span>
          <Money cents={totals.unclaimedCents} />
        </div>
        {isOrganizer && (
          <div className="row-between">
            <span className="muted">Received so far</span>
            <Money cents={collected} className="strong" />
          </div>
        )}
      </div>

      {people.map((pid) => {
        const person = totals.people[pid];
        const total = person?.totalCents ?? 0;
        const isOrg = pid === organizerId;
        const settlement = data.settlements.find((s) => s.userId === pid);
        const state = settlementState(total, settlement, isOrg);
        const badge = stateBadge(state, haul.organizer.name);
        const showStatus = !isOrg && (isOrganizer || pid === meId);
        return (
          <div key={pid} className="card tight">
            <details>
              <summary>
                <div className="row">
                  <Avatar name={names[pid] === "You" ? data.members.find((m) => m.id === pid)?.name ?? "You" : names[pid] ?? "?"} />
                  <div className="grow">
                    <div className="strong">
                      {names[pid] ?? "Former member"}
                      {isOrg && <span className="muted small"> · organizer</span>}
                    </div>
                    {showStatus ? (
                      <span className={`badge ${badge.tone}`}>{badge.text}</span>
                    ) : (
                      <span className="small muted">
                        {person ? `${person.lines.length} item${person.lines.length === 1 ? "" : "s"}` : "No picks"}
                        {isOrg && totals.unclaimedCents > 0 ? ` + ${formatCents(totals.unclaimedCents)} unclaimed` : ""}
                      </span>
                    )}
                  </div>
                  <Money cents={total} className="strong" />
                </div>
              </summary>
              <div className="person-lines">
                {(person?.lines ?? []).map((line) => {
                  const item = itemById[line.itemId];
                  return (
                    <div key={line.itemId} className="row-between">
                      <span className="grow truncate">
                        {item?.name}{" "}
                        <span className="muted">
                          · {item && item.shares > 1 ? `${line.shares} × ${portionLabel(item.quantity, item.unit, item.shares)}` : "whole"}
                        </span>
                      </span>
                      <Money cents={line.cents} />
                    </div>
                  );
                })}
                {!person && <span className="muted">No picks.</span>}
              </div>
            </details>
            {isOrganizer && !isOrg && total > 0 && (
              <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
                {state.kind === "paid" ? (
                  <button className="btn sm ghost" onClick={() => settle(pid, "unreceived", "Marked as not received")}>
                    Undo received
                  </button>
                ) : (
                  <button className="btn sm soft" onClick={() => settle(pid, "received", `Marked ${formatCents(total)} received`)}>
                    <Icon name="check" size={16} /> Got {formatCents(total)}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {notPicked.length > 0 && (
        <p className="small muted" style={{ padding: "0 2px" }}>
          Haven't picked anything: {notPicked.map((m) => (m.id === meId ? "you" : m.name)).join(", ")}
        </p>
      )}

      {isOrganizer && haul.status !== "draft" && (
        <div className="card flat stack" style={{ gap: 8 }}>
          {haul.status === "open" ? (
            <>
              <p className="small">
                <b>Done collecting picks?</b> Close the haul so nobody changes their order after you've divided things up.
              </p>
              <button className="btn" onClick={() => onStatus("closed")}>
                <Icon name="lock" size={16} /> Close picks
              </button>
            </>
          ) : (
            <>
              <p className="small">Picks are closed. You can still change anything yourself.</p>
              <button className="btn" onClick={() => onStatus("open")}>
                Reopen picks
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ bottom bar

function BottomBar({
  data,
  myTotal,
  myItemCount,
  myState,
  totals,
  onShare,
  onPay,
  onPeople,
}: {
  data: HaulDetail;
  myTotal: number;
  myItemCount: number;
  myState: SettlementState;
  totals: HaulTotals;
  onShare: () => void;
  onPay: () => void;
  onPeople: () => void;
}) {
  const { haul, isOrganizer } = data;
  if (isOrganizer) {
    const fromOthers = Object.values(totals.people)
      .filter((p) => p.userId !== haul.organizer.id)
      .reduce((s, p) => s + p.totalCents, 0);
    const received = data.settlements.reduce((s, x) => s + x.verifiedCents, 0);
    return (
      <div className="bottom-bar">
        <div className="bottom-bar-inner">
          <button className="grow" onClick={onPeople} style={{ background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer" }}>
            <p className="tiny muted">{haul.status === "draft" ? "Haul total" : "Received from others"}</p>
            <p className="total-big">
              {haul.status === "draft" ? (
                formatCents(totals.haulCents)
              ) : (
                <>
                  {formatCents(received)} <span className="small muted">of {formatCents(fromOthers)}</span>
                </>
              )}
            </p>
          </button>
          <button className="btn primary lg" onClick={onShare}>
            <Icon name="share" size={18} /> {haul.status === "draft" ? "Share with group" : "Share"}
          </button>
        </div>
      </div>
    );
  }

  const label =
    myState.kind === "paid"
      ? "Paid"
      : myState.kind === "sent"
        ? "Sent"
        : myState.kind === "owes" && (myState.paidCents > 0 || haul.status === "closed" || data.settlements.find((s) => s.userId === data.meId)?.confirmedAt)
          ? "Pay"
          : "Review & pay";
  return (
    <div className="bottom-bar">
      <div className="bottom-bar-inner">
        <div className="grow">
          <p className="tiny muted">
            Your share{myItemCount ? ` · ${myItemCount} item${myItemCount === 1 ? "" : "s"}` : ""}
          </p>
          <p className="total-big">{formatCents(myTotal)}</p>
        </div>
        <button className="btn primary lg" disabled={myTotal === 0 && myState.kind === "none"} onClick={onPay}>
          {myState.kind === "paid" && <Icon name="check" size={18} />}
          {myTotal === 0 && myState.kind === "none" ? "Pick items above" : label}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings

function HaulSettings({
  data,
  onClose,
  onSave,
  onDelete,
}: {
  data: HaulDetail;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { haul } = data;
  const [title, setTitle] = useState(haul.title);
  const [purchasedOn, setPurchasedOn] = useState(haul.purchasedOn ?? "");
  const [store, setStore] = useState(haul.store ?? "");
  const [pickup, setPickup] = useState(haul.pickup ?? "");
  const [taxRate, setTaxRate] = useState(haul.taxRate ? String(haul.taxRate) : "");
  const [status, setStatus] = useState<HaulStatus>(haul.status);

  function submit(e: FormEvent) {
    e.preventDefault();
    void onSave({
      title,
      purchasedOn: purchasedOn || null,
      store: store || null,
      pickup: pickup || null,
      taxRate: Number(taxRate) || 0,
      status,
    });
  }

  return (
    <Sheet title="Haul settings" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="s-title">Name</label>
          <input id="s-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={80} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="s-date">Bought on</label>
            <input id="s-date" className="input" type="date" value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="s-tax">Sales tax %</label>
            <input
              id="s-tax"
              className="input num"
              inputMode="decimal"
              placeholder="0"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value.replace(/[^\d.]/g, ""))}
            />
          </div>
        </div>
        <p className="hint" style={{ marginTop: -6 }}>
          Tax is added only to items marked "taxed". Scanning a receipt fills this in for you.
        </p>
        <div className="field">
          <label htmlFor="s-store">Store</label>
          <input id="s-store" className="input" value={store} onChange={(e) => setStore(e.target.value)} maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="s-pickup">Pickup details</label>
          <textarea id="s-pickup" className="input" value={pickup} onChange={(e) => setPickup(e.target.value)} maxLength={300} />
        </div>
        <div className="field">
          <span className="label">Who can pick</span>
          <div className="chips">
            {(["draft", "open", "closed"] as const).map((s) => (
              <button type="button" key={s} className={`chip${status === s ? " on" : ""}`} onClick={() => setStatus(s)}>
                {s === "draft" ? "Just me (draft)" : s === "open" ? "Open for picks" : "Closed"}
              </button>
            ))}
          </div>
        </div>
        <button className="btn primary block">Save</button>
        <button
          type="button"
          className="btn ghost danger block"
          onClick={() => window.confirm(`Delete "${haul.title}" and everyone's picks? This can't be undone.`) && void onDelete()}
        >
          <Icon name="trash" size={18} /> Delete haul
        </button>
      </form>
    </Sheet>
  );
}
