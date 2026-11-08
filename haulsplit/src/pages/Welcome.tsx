import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import type { Me } from "../../shared/api";
import { api } from "../api";
import { useSession } from "../session";
import { Icon, Loading, TopBar, errorMessage } from "../ui";

/** Name (+ optional email/password) sign-up, or email/password log-in. Also used by the invite page. */
export function AuthForm({
  inviteCode,
  initialMode = "start",
  submitLabel,
  onDone,
}: {
  inviteCode?: string;
  initialMode?: "start" | "login";
  submitLabel?: string;
  onDone: (result: { me: Me; groupId: string | null }) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [withLogin, setWithLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "login"
          ? await api<{ me: Me; groupId: string | null }>("POST", "/auth/login", { email, password, inviteCode })
          : await api<{ me: Me; groupId: string | null }>("POST", "/auth/start", {
              name,
              email: withLogin ? email : "",
              password: withLogin ? password : "",
              inviteCode,
            });
      onDone(result);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      {mode === "start" ? (
        <>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              className="input"
              autoComplete="name"
              placeholder="e.g. Sam"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
            />
            <span className="hint">This is what your group sees.</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={withLogin} onChange={(e) => setWithLogin(e.target.checked)} />
            <span>
              Add an email &amp; password
              <span className="hint" style={{ display: "block" }}>
                Optional. Lets you log in on other devices. You can do this later.
              </span>
            </span>
          </label>
          {withLogin && (
            <>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <span className="hint">At least 8 characters.</span>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      <button className="btn primary lg block" disabled={busy}>
        {busy ? <span className="spinner" /> : mode === "login" ? "Log in" : (submitLabel ?? "Get started")}
      </button>
      <p className="small muted" style={{ textAlign: "center" }}>
        {mode === "login" ? (
          <>
            New here?{" "}
            <button type="button" className="link-btn" onClick={() => setMode("start")}>
              Start with just your name
            </button>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <button type="button" className="link-btn" onClick={() => setMode("login")}>
              Log in
            </button>
          </>
        )}
      </p>
      {mode === "login" && (
        <p className="tiny muted" style={{ textAlign: "center" }}>
          Forgot your password, or never set one? Ask your group's owner for a login link, or open one from a device you're
          still logged in on (Profile → Log in on another device).
        </p>
      )}
    </form>
  );
}

export function Welcome() {
  const { me, ready, setMe } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get("next") || "/";

  if (!ready) return <Loading />;
  if (me) return <Navigate to={next} replace />;

  return (
    <>
      <TopBar />
      <main className="page">
        <section className="hero">
          <h1>Split the Costco run.</h1>
          <p className="lead">
            Buy in bulk, share with friends and family. Everyone picks the portions they want, and the app tells them exactly what
            to Zelle you.
          </p>
        </section>
        <ol className="steps card flat">
          <li>
            <span>
              <b>Add your haul</b> — scan the receipt or barcodes, or type items in.
            </span>
          </li>
          <li>
            <span>
              <b>Share the link</b> — people pick, say, 2 lb of the 8 lb of chicken.
            </span>
          </li>
          <li>
            <span>
              <b>Get paid back</b> — each person sees their total and your Zelle info.
            </span>
          </li>
        </ol>
        <AuthForm
          initialMode={params.get("mode") === "login" ? "login" : "start"}
          onDone={({ me }) => {
            setMe(me);
            navigate(next, { replace: true });
          }}
        />
        <p className="tiny muted row" style={{ justifyContent: "center" }}>
          <Icon name="lock" size={14} /> Your group's hauls are only visible to people you invite.
        </p>
      </main>
    </>
  );
}
