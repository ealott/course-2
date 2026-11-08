import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { TopBar, errorMessage } from "../ui";

export function NewGroup() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("POST", "/groups", { name });
      navigate(`/g/${id}?created=1`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar back title="New group" />
      <main className="page">
        <form className="card stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="group-name">Group name</label>
            <input
              id="group-name"
              className="input"
              placeholder="e.g. Family, Roommates, Costco crew"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              autoFocus
            />
            <span className="hint">Next you'll get an invite link to send everyone.</span>
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="btn primary lg block" disabled={busy}>
            {busy ? <span className="spinner" /> : "Create group"}
          </button>
        </form>
      </main>
    </>
  );
}
