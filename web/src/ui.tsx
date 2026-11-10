import DOMPurify from "dompurify";
import { marked } from "marked";
import { type ReactNode, useEffect, useMemo } from "react";
import type { SessionStatus } from "./types.ts";
import { parseIssueRef } from "../../shared/board.ts";

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

// Line icons in the Lucide style (ISC licence), drawn in currentColor; they stand in for the emoji the UI used.
const ICON_PATHS = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
  external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
};

export function Icon({ name, label }: { name: keyof typeof ICON_PATHS; label?: string }) {
  return (
    <span className="icon" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[name]}
      </svg>
    </span>
  );
}

// A loader keeps turning under reduced motion (slower), so `keep-motion` exempts it from base.css's stop.
export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner keep-motion ${small ? "spinner-sm" : ""}`} aria-label="Loading" />;
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

/**
 * The repo id and issue number of an issue ref that names its repo (`owner/name#123` or the
 * issue's URL), read with shared/board.ts's parseIssueRef; null for any other ref.
 */
export function repoIssue(issueRef: string | null | undefined): { repoId: string; number: number } | null {
  const issue = parseIssueRef(issueRef ?? null);
  return issue?.repo ? { repoId: issue.repo, number: issue.number } : null;
}

/** The GitHub page of an issue ref that names its repo. */
export const issueUrl = (issueRef: string | null | undefined) => {
  const p = repoIssue(issueRef);
  return p ? `https://github.com/${p.repoId}/issues/${p.number}` : undefined;
};

export const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n));
