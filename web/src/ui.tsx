import DOMPurify from "dompurify";
import { marked } from "marked";
import { type ReactNode, useEffect, useMemo } from "react";
import type { SessionStatus } from "./types.ts";

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Working",
  waiting: "Needs you",
  idle: "Your turn",
  starting: "Starting",
  stopped: "Stopped",
  error: "Error",
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`dot dot-${status}`} aria-hidden />;
}

export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`pill pill-${status}`}>
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner ${small ? "spinner-sm" : ""}`} aria-label="Loading" />;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      <div className="row gap">{children}</div>
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark">π</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export const ago = (ts: number) => {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** The issue-detail hash link for an `owner/name#123` ref. */
export const issueUrl = (issueRef: string) => {
  const [repoId, number] = issueRef.split("#");
  return `#/issues/${encodeURIComponent(repoId)}/${number}`;
};

export const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n));
