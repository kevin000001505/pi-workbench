import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { applyEvent, emptyTranscript, type RpcEvent, type Transcript } from "../../shared/transcript.ts";
import type { SessionSummary } from "./types.ts";

type Toast = { id: number; text: string; level: "info" | "warning" | "error" };

type Store = {
  connected: boolean;
  sessions: Record<string, SessionSummary>;
  transcript: (id: string) => Transcript | undefined;
  stderr: (id: string) => string[];
  /** Bumps whenever the open transcript changes; components read it to re-render. */
  version: number;
  watch: (id: string | null) => void;
  upsert: (s: SessionSummary) => void;
  toasts: Toast[];
  toast: (text: string, level?: Toast["level"]) => void;
  dismiss: (id: number) => void;
};

const Ctx = createContext<Store | null>(null);

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}

const NOTIFY_KEY = "wb.notify";
export const notificationsEnabled = () => {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== "off" && "Notification" in window && Notification.permission === "granted";
  } catch {
    return false;
  }
};
export function setNotifications(on: boolean) {
  try {
    localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
  } catch {}
}

function notify(session: SessionSummary, title: string, body: string, tag: string) {
  if (!notificationsEnabled() || !document.hidden) return;
  const n = new Notification(`${title} · ${session.title}`, { body: body.slice(0, 200), tag });
  n.onclick = () => {
    window.focus();
    location.hash = `#/session/${session.id}`;
    n.close();
  };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<Record<string, SessionSummary>>({});
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const transcripts = useRef(new Map<string, Transcript>());
  const stderrs = useRef(new Map<string, string[]>());
  const watched = useRef<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const frame = useRef(0);
  const seenPending = useRef(new Set<string>());
  /** Last known attention/phase per session, to notify on changes only. */
  const lastState = useRef(new Map<string, string>());

  const bump = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setVersion((v) => v + 1);
    });
  }, []);

  const toast = useCallback((text: string, level: Toast["level"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === "error" ? 9000 : 5000);
  }, []);

  const upsert = useCallback((s: SessionSummary) => {
    for (const req of s.pending) {
      if (!seenPending.current.has(req.id)) {
        seenPending.current.add(req.id);
        notify(
          s,
          req.kind === "permission" ? "Permission needed" : "Decision needed",
          req.kind === "permission" ? `${req.subject ?? req.tool}` : req.title,
          req.id,
        );
      }
    }
    // The pipeline stopping for you, or finishing, is worth a notification too.
    const key = `${s.attention ?? ""}|${s.phase}`;
    const prev = lastState.current.get(s.id);
    lastState.current.set(s.id, key);
    if (prev !== undefined && prev !== key) {
      if (s.attention) notify(s, "Pipeline needs you", s.attention, `${s.id}-attention`);
      else if (s.phase === "done" && s.mode === "pipeline" && !prev.endsWith("|done")) notify(s, "All tickets done", "Review and create the PR.", `${s.id}-done`);
    }
    setSessions((prev) => ({ ...prev, [s.id]: s }));
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry = 500;
    const connect = () => {
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 500;
        setConnected(true);
        if (watched.current) sock.send(JSON.stringify({ type: "subscribe", sessionId: watched.current }));
      };
      sock.onclose = () => {
        setConnected(false);
        if (!stopped) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
      };
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case "sessions": {
            const next: Record<string, SessionSummary> = {};
            for (const s of msg.sessions as SessionSummary[]) {
              next[s.id] = s;
              for (const r of s.pending) seenPending.current.add(r.id);
              lastState.current.set(s.id, `${s.attention ?? ""}|${s.phase}`);
            }
            setSessions(next);
            break;
          }
          case "summary":
            upsert(msg.session);
            break;
          case "removed":
            setSessions((prev) => {
              const { [msg.id]: _, ...rest } = prev;
              return rest;
            });
            break;
          case "snapshot":
            transcripts.current.set(msg.sessionId, msg.transcript);
            stderrs.current.set(msg.sessionId, msg.stderr ?? []);
            upsert(msg.summary);
            bump();
            break;
          case "event": {
            const ev = msg.event as RpcEvent;
            if (ev.type === "wb_notify") toast(String(ev.message), ev.level);
            else if (ev.type === "wb_exit" && ev.error) toast(ev.error, "error");
            else if (ev.type === "extension_error") toast(`Extension error: ${ev.error}`, "error");
            else if (ev.type === "wb_run") {
              // The session moved to another pi conversation (next ticket): reload it.
              transcripts.current.set(msg.sessionId, emptyTranscript());
              ws.current?.send(JSON.stringify({ type: "subscribe", sessionId: msg.sessionId }));
              bump();
              break;
            }
            const t = transcripts.current.get(msg.sessionId) ?? emptyTranscript();
            transcripts.current.set(msg.sessionId, applyEvent(t, ev));
            bump();
            break;
          }
          case "error":
            toast(msg.error, "error");
            break;
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      ws.current?.close();
    };
  }, [bump, toast, upsert]);

  const watch = useCallback((id: string | null) => {
    const sock = ws.current;
    const prev = watched.current;
    if (prev === id) return;
    if (prev && sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "unsubscribe", sessionId: prev }));
    if (prev) transcripts.current.delete(prev);
    watched.current = id;
    if (id && sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "subscribe", sessionId: id }));
  }, []);

  // Tab title shows how many sessions wait on you.
  useEffect(() => {
    const waiting = Object.values(sessions).filter((s) => s.pending.length > 0 || s.attention).length;
    document.title = waiting ? `(${waiting}) pi workbench` : "pi workbench";
  }, [sessions]);

  const value = useMemo<Store>(
    () => ({
      connected,
      sessions,
      version,
      transcript: (id) => transcripts.current.get(id),
      stderr: (id) => stderrs.current.get(id) ?? [],
      watch,
      upsert,
      toasts,
      toast,
      dismiss: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    }),
    [connected, sessions, version, watch, upsert, toasts, toast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
