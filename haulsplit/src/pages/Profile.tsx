import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Me } from "../../shared/api";
import { api } from "../api";
import { useMe, useSession } from "../session";
import { CopyButton, Icon, Sheet, TopBar, errorMessage, useShare, useToast } from "../ui";

export function Profile() {
  const me = useMe();
  const { setMe } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const share = useShare();
  const [name, setName] = useState(me.name);
  const [zelle, setZelle] = useState(me.zelle ?? "");
  const [email, setEmail] = useState(me.email ?? "");
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [error, setError] = useState("");
  const [credError, setCredError] = useState("");

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await api<{ me: Me }>("PATCH", "/me", { name, zelle: zelle.trim() || null });
      setMe(res.me);
      toast("Saved");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function saveCredentials(e: FormEvent) {
    e.preventDefault();
    setCredError("");
    try {
      const res = await api<{ me: Me }>("PUT", "/me/credentials", { email, password, currentPassword: current || undefined });
      setMe(res.me);
      setPassword("");
      setCurrent("");
      toast(me.hasPassword ? "Password changed" : "You can now log in anywhere with your email");
    } catch (err) {
      setCredError(errorMessage(err));
    }
  }

  async function makeLoginLink() {
    try {
      const { url } = await api<{ url: string }>("POST", "/me/login-link");
      setLoginUrl(url);
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  }

  async function logout() {
    await api("POST", "/auth/logout").catch(() => {});
    setMe(null);
    navigate("/welcome", { replace: true });
  }

  return (
    <>
      <TopBar back="/" title="Profile" />
      <main className="page">
        {params.get("welcome") && !me.hasPassword && (
          <div className="card tinted small">
            You're logged in on this device. Add an email and password below if you want to log in elsewhere without a link.
          </div>
        )}

        <form className="card stack" onSubmit={saveProfile}>
          <h2>You</h2>
          <div className="field">
            <label htmlFor="p-name">Name</label>
            <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </div>
          <div className="field">
            <label htmlFor="p-zelle">Zelle email or phone</label>
            <input
              id="p-zelle"
              className="input"
              inputMode="email"
              placeholder="Where people send money when you organize"
              value={zelle}
              onChange={(e) => setZelle(e.target.value)}
              maxLength={120}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="btn primary">Save</button>
        </form>

        <form className="card stack" onSubmit={saveCredentials}>
          <div>
            <h2>{me.hasPassword ? "Email & password" : "Add a login"}</h2>
            <p className="small muted">
              {me.hasPassword
                ? "Use these to log in on a new phone or computer."
                : "Right now you're only logged in on this device. Add an email and password to log in anywhere."}
            </p>
          </div>
          <div className="field">
            <label htmlFor="p-email">Email</label>
            <input id="p-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          {me.hasPassword && (
            <div className="field">
              <label htmlFor="p-current">Current password</label>
              <input id="p-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              <span className="hint">Not needed if you just used a login link.</span>
            </div>
          )}
          <div className="field">
            <label htmlFor="p-password">{me.hasPassword ? "New password" : "Password"}</label>
            <input
              id="p-password"
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {credError && <p className="error-text">{credError}</p>}
          <button className="btn">{me.hasPassword ? "Change password" : "Save login"}</button>
        </form>

        <div className="card stack">
          <div>
            <h2>Log in on another device</h2>
            <p className="small muted">Get a one-time link that logs this account in somewhere else. It expires in 30 minutes.</p>
          </div>
          <button className="btn" onClick={makeLoginLink}>
            <Icon name="link" size={18} /> Make a login link
          </button>
        </div>

        <button className="btn ghost danger" onClick={logout}>
          <Icon name="logout" size={18} /> Log out
        </button>
      </main>

      {loginUrl && (
        <Sheet title="Your login link" onClose={() => setLoginUrl("")}>
          <div className="stack">
            <p className="small muted">Open this on the other device within 30 minutes. It works once.</p>
            <div className="copy-row">
              <span className="value small">{loginUrl}</span>
            </div>
            <div className="row">
              <button className="btn primary grow" onClick={() => share({ title: "HaulSplit login link", url: loginUrl })}>
                <Icon name="share" size={18} /> Send to myself
              </button>
              <CopyButton text={loginUrl} what="Login link" />
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
