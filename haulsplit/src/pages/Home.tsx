import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { HaulSummary, HomeData } from "../../shared/api";
import { formatCents } from "../../shared/money";
import { useApi } from "../api";
import { formatDate } from "../dates";
import { useMe } from "../session";
import { Avatar, Empty, ErrorState, ExpiryBadge, Icon, Loading, Money, Sheet, TopBar } from "../ui";

type Tone = "ok" | "warn" | "danger" | "primary" | "";

export function haulStatus(h: HaulSummary): { text: string; tone: Tone } {
  if (h.isOrganizer) {
    if (h.status === "draft") return { text: "Draft · only you can see it", tone: "warn" };
    if (h.outstandingCents > 0) return { text: `${formatCents(h.outstandingCents)} still to collect`, tone: "primary" };
    if (h.status === "open") return { text: "Open for picks", tone: "primary" };
    return { text: "All settled", tone: "ok" };
  }
  const owed = h.myTotalCents - h.myPaidCents;
  if (h.myTotalCents === 0 && h.myPaidCents === 0) {
    return h.status === "open" ? { text: "Pick your share", tone: "primary" } : { text: "You didn't take anything", tone: "" };
  }
  if (owed < 0) return { text: `${h.organizerName} owes you ${formatCents(-owed)}`, tone: "warn" };
  if (owed === 0) {
    return h.myVerifiedCents >= h.myTotalCents
      ? { text: "Paid", tone: "ok" }
      : { text: `Sent · waiting for ${h.organizerName} to confirm`, tone: "" };
  }
  if (h.status === "open" && !h.myConfirmed && h.myPaidCents === 0) return { text: `Picking · ${formatCents(h.myTotalCents)} so far`, tone: "primary" };
  return { text: `You owe ${formatCents(owed)}`, tone: "warn" };
}

function needsAttention(h: HaulSummary): boolean {
  if (h.isOrganizer) return h.status === "draft" || h.outstandingCents > 0;
  const owed = h.myTotalCents - h.myPaidCents;
  return (h.status === "open" && !h.myConfirmed && h.myPaidCents === 0) || owed !== 0;
}

export function HaulCard({ h, showGroup = true }: { h: HaulSummary; showGroup?: boolean }) {
  const status = haulStatus(h);
  return (
    <Link to={`/h/${h.id}`} className="card tight">
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="grow stack" style={{ gap: 4 }}>
          <h3 className="truncate">{h.title}</h3>
          <p className="small muted truncate">
            {[showGroup ? h.groupName : null, h.isOrganizer ? "You organized" : `by ${h.organizerName}`, formatDate(h.purchasedOn)]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
            <span className={`badge ${status.tone}`}>{status.text}</span>
            {h.nextExpiry && <ExpiryBadge date={h.nextExpiry} />}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <Money cents={h.isOrganizer ? h.haulCents : h.myTotalCents} className="strong" />
          <p className="tiny muted">{h.isOrganizer ? "haul total" : "your share"}</p>
        </div>
      </div>
    </Link>
  );
}

export function Home() {
  const me = useMe();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<HomeData>("/home", { poll: 30_000 });
  const [picking, setPicking] = useState(false);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorState message={error?.message ?? "Couldn't load."} onRetry={reload} />;

  const attention = data.hauls.filter(needsAttention);
  const rest = data.hauls.filter((h) => !needsAttention(h));

  function newHaul() {
    if (!data || data.groups.length === 0) navigate("/groups/new");
    else if (data.groups.length === 1) navigate(`/g/${data.groups[0].id}/new`);
    else setPicking(true);
  }

  return (
    <>
      <TopBar
        right={
          <Link to="/me" aria-label="Your profile" style={{ textDecoration: "none" }}>
            <Avatar name={me.name} />
          </Link>
        }
      />
      <main className="page">
        <div className="row-between">
          <div>
            <h1>Hi, {me.name.split(" ")[0]}</h1>
            <p className="muted small">Your shared bulk buys</p>
          </div>
          {data.groups.length > 0 && (
            <button className="btn primary" onClick={newHaul}>
              <Icon name="plus" size={18} /> New haul
            </button>
          )}
        </div>

        {data.groups.length === 0 ? (
          <Empty icon="users" title="Start a group">
            <p className="muted">
              A group is the people you split with — family, roommates, friends. Create one and send them the invite link.
            </p>
            <Link to="/groups/new" className="btn primary">
              Create a group
            </Link>
            <p className="tiny muted">Got an invite link from someone? Just open it.</p>
          </Empty>
        ) : data.hauls.length === 0 ? (
          <Empty icon="bag" title="No hauls yet">
            <p className="muted">Back from a Costco run? Add what you bought and let everyone pick their share.</p>
            <button className="btn primary" onClick={newHaul}>
              Add a haul
            </button>
          </Empty>
        ) : null}

        {attention.length > 0 && (
          <>
            <h2 className="section-title">Needs you</h2>
            <div className="list">
              {attention.map((h) => (
                <HaulCard key={h.id} h={h} showGroup={data.groups.length > 1} />
              ))}
            </div>
          </>
        )}

        {rest.length > 0 && (
          <>
            <h2 className="section-title">{attention.length ? "Everything else" : "Hauls"}</h2>
            <div className="list">
              {rest.map((h) => (
                <HaulCard key={h.id} h={h} showGroup={data.groups.length > 1} />
              ))}
            </div>
          </>
        )}

        {data.groups.length > 0 && (
          <>
            <h2 className="section-title">Groups</h2>
            <div className="list-rows">
              {data.groups.map((g) => (
                <Link key={g.id} to={`/g/${g.id}`} className="list-row">
                  <span className="empty-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
                    <Icon name="users" size={18} />
                  </span>
                  <span className="grow">
                    <span className="strong">{g.name}</span>
                    <span className="small muted" style={{ display: "block" }}>
                      {g.memberCount} {g.memberCount === 1 ? "member" : "members"}
                      {g.isOwner ? " · you own it" : ""}
                    </span>
                  </span>
                  <Icon name="chevron" />
                </Link>
              ))}
              <Link to="/groups/new" className="list-row muted">
                <Icon name="plus" /> New group
              </Link>
            </div>
          </>
        )}
      </main>

      {picking && (
        <Sheet title="Which group is this for?" onClose={() => setPicking(false)}>
          <div className="list-rows">
            {data.groups.map((g) => (
              <button key={g.id} className="list-row" onClick={() => navigate(`/g/${g.id}/new`)}>
                <span className="grow strong">{g.name}</span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
