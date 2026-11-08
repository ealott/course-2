import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { GroupDetail, Member } from "../../shared/api";
import { api, useApi } from "../api";
import { useMe } from "../session";
import { Avatar, CopyButton, ErrorState, Icon, Loading, Sheet, TopBar, errorMessage, useShare, useToast } from "../ui";
import { HaulCard } from "./Home";

export function GroupPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const me = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const share = useShare();
  const { data, error, loading, reload } = useApi<GroupDetail>(`/groups/${id}`);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [linkFor, setLinkFor] = useState<{ member: Member; url: string } | null>(null);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorState message={error?.message ?? "Couldn't load the group."} onRetry={reload} />;

  const { group, members, hauls } = data;
  const isOwner = group.ownerId === me.id;
  const inviteUrl = `${window.location.origin}/join/${group.inviteCode}`;

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) toast(done);
      await reload();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  }

  async function loginLink(member: Member) {
    try {
      const { url } = await api<{ url: string }>("POST", `/groups/${group.id}/members/${member.id}/login-link`);
      setLinkFor({ member, url });
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  }

  return (
    <>
      <TopBar
        back="/"
        title={group.name}
        right={
          isOwner && (
            <button className="icon-btn" aria-label="Rename group" onClick={() => setRenaming(true)}>
              <Icon name="edit" />
            </button>
          )
        }
      />
      <main className="page">
        <div className="row-between">
          <h1 className="grow">{group.name}</h1>
          <Link to={`/g/${group.id}/new`} className="btn primary">
            <Icon name="plus" size={18} /> New haul
          </Link>
        </div>

        <section className={`card stack ${params.get("created") ? "tinted" : ""}`}>
          <div>
            <h2>Invite people</h2>
            <p className="small muted">Anyone with this link can join {group.name} with just their name.</p>
          </div>
          <div className="copy-row">
            <span className="value small">{inviteUrl.replace(/^https?:\/\//, "")}</span>
          </div>
          <div className="row">
            <button
              className="btn primary grow"
              onClick={() => share({ title: `Join ${group.name} on HaulSplit`, text: `Join "${group.name}" so we can split bulk buys:`, url: inviteUrl })}
            >
              <Icon name="share" size={18} /> Share invite
            </button>
            <CopyButton text={inviteUrl} what="Invite link" />
          </div>
          {isOwner && (
            <button
              className="link-btn small"
              style={{ alignSelf: "flex-start" }}
              onClick={() =>
                window.confirm("Make a new invite link? The old one will stop working.") &&
                act(() => api("POST", `/groups/${group.id}/invite/rotate`), "New invite link made")
              }
            >
              Reset invite link
            </button>
          )}
        </section>

        <h2 className="section-title">Hauls</h2>
        {hauls.length === 0 ? (
          <p className="muted small" style={{ padding: "0 2px" }}>
            No hauls yet. Tap <b>New haul</b> after your next shopping trip.
          </p>
        ) : (
          <div className="list">
            {hauls.map((h) => (
              <HaulCard key={h.id} h={h} showGroup={false} />
            ))}
          </div>
        )}

        <h2 className="section-title">Members · {members.length}</h2>
        <div className="list-rows">
          {members.map((m) => (
            <div key={m.id} className="list-row">
              <Avatar name={m.name} />
              <div className="grow">
                <div className="strong">
                  {m.name}
                  {m.id === me.id && <span className="muted"> (you)</span>}
                </div>
                <div className="row wrap" style={{ gap: 4, marginTop: 2 }}>
                  {m.isOwner && <span className="badge primary">Owner</span>}
                  {!m.canLogIn && <span className="badge">No login · you pick for them</span>}
                </div>
              </div>
              {isOwner && m.id !== me.id && (
                <div className="row" style={{ gap: 2 }}>
                  {!m.hasPassword && (
                    <button className="icon-btn sm" aria-label={`Login link for ${m.name}`} title="Login link" onClick={() => loginLink(m)}>
                      <Icon name="link" size={18} />
                    </button>
                  )}
                  <button
                    className="icon-btn sm"
                    aria-label={`Remove ${m.name}`}
                    title="Remove"
                    onClick={() =>
                      window.confirm(`Remove ${m.name} from ${group.name}?`) &&
                      act(() => api("DELETE", `/groups/${group.id}/members/${m.id}`), `${m.name} removed`)
                    }
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              )}
            </div>
          ))}
          <button className="list-row muted" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            <span className="grow">
              Add someone who won't use the app
              <span className="tiny" style={{ display: "block" }}>
                e.g. Grandma — the organizer picks portions for them
              </span>
            </span>
          </button>
        </div>

        {!isOwner && (
          <button
            className="btn ghost danger"
            onClick={() =>
              window.confirm(`Leave ${group.name}?`) &&
              act(async () => {
                await api("DELETE", `/groups/${group.id}/members/${me.id}`);
                navigate("/", { replace: true });
              })
            }
          >
            Leave group
          </button>
        )}
      </main>

      {adding && <AddPersonSheet groupId={group.id} onClose={() => setAdding(false)} onAdded={reload} />}
      {renaming && <RenameSheet groupId={group.id} name={group.name} onClose={() => setRenaming(false)} onSaved={reload} />}
      {linkFor && (
        <Sheet title={`Login link for ${linkFor.member.name}`} onClose={() => setLinkFor(null)}>
          <div className="stack">
            <p className="muted small">
              Send this to {linkFor.member.name}. It logs them in once on any device and expires in 3 days. They can add a password
              afterwards.
            </p>
            <div className="copy-row">
              <span className="value small">{linkFor.url}</span>
            </div>
            <div className="row">
              <button
                className="btn primary grow"
                onClick={() => share({ title: "Your HaulSplit login link", text: `Here's your link to log in to ${group.name}:`, url: linkFor.url })}
              >
                <Icon name="share" size={18} /> Send
              </button>
              <CopyButton text={linkFor.url} what="Login link" />
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}

function AddPersonSheet({ groupId, onClose, onAdded }: { groupId: string; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("POST", `/groups/${groupId}/members`, { name });
      toast(`${name} added`);
      onAdded();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Sheet title="Add someone" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small muted">
          For people who'd rather not use the app. They'll show up in every haul so the organizer can pick portions for them and
          track what they owe.
        </p>
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={60} />
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary block">Add</button>
      </form>
    </Sheet>
  );
}

function RenameSheet({ groupId, name: initial, onClose, onSaved }: { groupId: string; name: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("PATCH", `/groups/${groupId}`, { name });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Sheet title="Rename group" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={60} />
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary block">Save</button>
      </form>
    </Sheet>
  );
}
