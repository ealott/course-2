import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Me } from "../../shared/api";
import { api } from "../api";
import { todayISO } from "../dates";
import { useSession } from "../session";
import { TopBar, errorMessage } from "../ui";

export function NewHaul() {
  const { id: groupId = "" } = useParams();
  const { me, setMe } = useSession();
  const navigate = useNavigate();
  const today = todayISO();
  const [title, setTitle] = useState("Costco run");
  const [purchasedOn, setPurchasedOn] = useState(today);
  const [store, setStore] = useState("");
  const [pickup, setPickup] = useState("");
  const [zelle, setZelle] = useState(me?.zelle ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (zelle.trim() !== (me?.zelle ?? "")) {
        const res = await api<{ me: Me }>("PATCH", "/me", { zelle: zelle.trim() || null });
        setMe(res.me);
      }
      const { id } = await api<{ id: string }>("POST", `/groups/${groupId}/hauls`, {
        title,
        purchasedOn: purchasedOn || null,
        store: store || null,
        pickup: pickup || null,
      });
      navigate(`/h/${id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar back title="New haul" />
      <main className="page">
        <form className="stack-lg" onSubmit={submit}>
          <div className="card stack">
            <div className="field">
              <label htmlFor="title">Name</label>
              <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={80} />
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="date">Bought on</label>
                <input id="date" className="input" type="date" value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="store">Store</label>
                <input id="store" className="input" placeholder="Costco" value={store} onChange={(e) => setStore(e.target.value)} maxLength={80} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="pickup">Pickup details</label>
              <textarea
                id="pickup"
                className="input"
                placeholder="e.g. At my place Sat 2–5pm. Frozen stuff is in the garage freezer — bring a cooler bag."
                value={pickup}
                onChange={(e) => setPickup(e.target.value)}
                maxLength={300}
              />
            </div>
          </div>

          <div className="card stack">
            <div className="field">
              <label htmlFor="zelle">Your Zelle email or phone</label>
              <input
                id="zelle"
                className="input"
                inputMode="email"
                placeholder="you@example.com or (555) 123-4567"
                value={zelle}
                onChange={(e) => setZelle(e.target.value)}
                maxLength={120}
              />
              <span className="hint">Shown to people when it's time to pay you back. Saved to your profile.</span>
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}
          <button className="btn primary lg block" disabled={busy}>
            {busy ? <span className="spinner" /> : "Create & add items"}
          </button>
          <p className="small muted" style={{ textAlign: "center", marginTop: -8 }}>
            It stays a private draft until you share it with the group.
          </p>
        </form>
      </main>
    </>
  );
}
