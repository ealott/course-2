import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatCents } from "../shared/money";
import { expiryInfo } from "./dates";

// ------------------------------------------------------------------ icons

const PATHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  back: <path d="M15 18l-6-6 6-6" />,
  chevron: <path d="M9 18l6-6-6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </>
  ),
  share: (
    <>
      <path d="M12 3v12M7.5 7.5L12 3l4.5 4.5" />
      <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </>
  ),
  barcode: <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10.5 8v8M14 8v8M17 8v8" />,
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.4 3.5 5.2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c.8-4 3.9-6 8-6s7.2 2 8 6" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 10h16M8 3v4M16 3v4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </>
  ),
  bag: (
    <>
      <path d="M5 8h14l-1 12H6z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  alert: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v4M12 17.5v.5" />
    </>
  ),
  dollar: <path d="M12 3v18M16.5 7.5c-.7-1.4-2.4-2.3-4.5-2.3-2.6 0-4.4 1.4-4.4 3.3 0 4.6 9 2.4 9 7 0 2-1.9 3.4-4.6 3.4-2.2 0-4-.9-4.8-2.5" />,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  snow: <path d="M12 2v20M4.9 6l14.2 12M19.1 6L4.9 18M9 4l3 2 3-2M9 20l3-2 3 2" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, strokeWidth = 2 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

// ------------------------------------------------------------------ layout

export function TopBar({ title, back, right }: { title?: ReactNode; back?: string | true; right?: ReactNode }) {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`topbar${scrolled ? " scrolled" : ""}`}>
      {back ? (
        <button
          className="icon-btn"
          aria-label="Back"
          onClick={() => (back === true ? (window.history.length > 1 ? navigate(-1) : navigate("/")) : navigate(back))}
        >
          <Icon name="back" size={24} />
        </button>
      ) : (
        <Link to="/" className="brand" aria-label="HaulSplit home">
          <img src="/icon.svg" alt="" />
          HaulSplit
        </Link>
      )}
      <div className="topbar-title">{back ? title : null}</div>
      {right}
    </header>
  );
}

export function Loading() {
  return (
    <div className="center-fill" role="status" aria-label="Loading">
      <span className="spinner" />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name="alert" />
      </div>
      <p>{message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
      <Link to="/" className="btn ghost">
        Go home
      </Link>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="card empty">
      <div className="empty-icon">
        <Icon name={icon} size={26} />
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ bits

export function Money({ cents, className }: { cents: number; className?: string }) {
  return <span className={`num ${className ?? ""}`}>{formatCents(cents)}</span>;
}

export function Avatar({ name, small }: { name: string; small?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return <span className={`avatar${small ? " sm" : ""}`}>{initials || "?"}</span>;
}

export function ExpiryBadge({ date }: { date: string }) {
  const info = expiryInfo(date);
  return (
    <span className={`badge ${info.tone === "neutral" ? "" : info.tone}`}>
      <Icon name="calendar" size={12} strokeWidth={2.5} />
      {info.label}
    </span>
  );
}

export function Stepper({
  value,
  min = 0,
  max,
  onChange,
  disabled,
  label,
}: {
  value: number;
  min?: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className={`stepper${value > 0 ? " active" : ""}`} role="group" aria-label={label}>
      <button aria-label={`Fewer ${label}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        <Icon name="minus" size={20} strokeWidth={2.6} />
      </button>
      <span className="count" aria-live="polite">
        {value}
      </span>
      <button aria-label={`More ${label}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        <Icon name="plus" size={20} strokeWidth={2.6} />
      </button>
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} ref={ref} tabIndex={-1}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2 className="grow">{title}</h2>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

const ToastContext = createContext<(text: string, opts?: { error?: boolean }) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, opts: { error?: boolean } = {}) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, error: opts.error }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.error ? 5000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

// ------------------------------------------------------------------ sharing

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / insecure contexts
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function CopyButton({ text, label = "Copy", what }: { text: string; label?: string; what?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm soft"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          toast(`${what ?? "Copied"}${what ? " copied" : ""}`);
          window.setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={16} />
      {done ? "Copied" : label}
    </button>
  );
}

/** Opens the phone's share sheet, or copies the link where that isn't available. */
export function useShare() {
  const toast = useToast();
  return useCallback(
    async (data: { title: string; text?: string; url: string }) => {
      if (navigator.share) {
        try {
          await navigator.share(data);
          return;
        } catch (err) {
          if ((err as DOMException)?.name === "AbortError") return;
        }
      }
      if (await copyText(data.url)) toast("Link copied");
    },
    [toast],
  );
}
