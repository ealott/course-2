import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, useApi } from "../api";
import { useSession } from "../session";
import { ErrorState, Icon, Loading, TopBar, errorMessage, useToast } from "../ui";
import { AuthForm } from "./Welcome";

interface Invite {
  group: { id: string; name: string; ownerName: string; memberCount: number };
  isMember: boolean;
}

export function Join() {
  const { code = "" } = useParams();
  const { me, ready, setMe } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const invite = useApi<Invite>(ready ? `/invites/${encodeURIComponent(code)}` : null);
  const [busy, setBusy] = useState(false);

  if (!ready || invite.loading) return <Loading />;
  if (invite.error || !invite.data) {
    return (
      <>
        <TopBar />
        <ErrorState message={invite.error?.message ?? "That invite link isn't valid."} />
      </>
    );
  }
  const { group, isMember } = invite.data;

  async function join() {
    setBusy(true);
    try {
      await api("POST", `/invites/${encodeURIComponent(code)}/join`);
      toast(`You joined ${group.name}`);
      navigate(`/g/${group.id}`, { replace: true });
    } catch (err) {
      toast(errorMessage(err), { error: true });
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page">
        <section className="hero" style={{ alignItems: "center", textAlign: "center" }}>
          <div className="empty-icon">
            <Icon name="users" size={28} />
          </div>
          <p className="muted">{group.ownerName} invited you to</p>
          <h1>{group.name}</h1>
          <p className="muted small">
            {group.memberCount} {group.memberCount === 1 ? "member" : "members"} · split bulk buys together
          </p>
        </section>

        {me ? (
          isMember ? (
            <button className="btn primary lg block" onClick={() => navigate(`/g/${group.id}`)}>
              You're in — open {group.name}
            </button>
          ) : (
            <div className="stack">
              <button className="btn primary lg block" disabled={busy} onClick={join}>
                {busy ? <span className="spinner" /> : `Join as ${me.name}`}
              </button>
              <p className="small muted" style={{ textAlign: "center" }}>
                Not {me.name}? Log out from your profile first.
              </p>
            </div>
          )
        ) : (
          <AuthForm
            inviteCode={code}
            submitLabel={`Join ${group.name}`}
            onDone={({ me, groupId }) => {
              setMe(me);
              navigate(groupId ? `/g/${groupId}` : "/", { replace: true });
            }}
          />
        )}
      </main>
    </>
  );
}
