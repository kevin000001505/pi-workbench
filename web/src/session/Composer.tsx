import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import type { Skill } from "../types.ts";

export function useSkills(sessionId?: string) {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    api
      .get<Skill[]>(`/api/skills${sessionId ? `?sessionId=${sessionId}` : ""}`)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [sessionId]);
  return skills;
}

/** Searchable list of skills; picking one inserts `/skill:name ` into the prompt. */
export function SkillPicker({
  skills,
  query,
  onPick,
  onClose,
}: {
  skills: Skill[];
  query: string;
  onPick: (s: Skill) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const list = useMemo(() => {
    const q = query.toLowerCase();
    return skills
      .filter((s) => s.name !== "setup-matt-pocock-skills" || q.includes("setup"))
      .filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q));
  }, [skills, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, list.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if ((e.key === "Enter" || e.key === "Tab") && list[active]) {
        e.preventDefault();
        e.stopPropagation();
        onPick(list[active]);
      } else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [list, active, onPick, onClose]);

  return (
    <div className="skill-picker" role="listbox">
      <div className="skill-picker-head">
        Skills <span className="muted small">↑↓ to move · Enter to insert · Esc to close</span>
      </div>
      {list.length === 0 && <div className="muted skill-empty">No skill matches “{query}”.</div>}
      {list.map((s, i) => (
        <button
          key={s.name}
          role="option"
          aria-selected={i === active}
          className={`skill ${i === active ? "active" : ""}`}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s);
          }}
        >
          <span className="skill-name mono">/{s.name}</span>
          {s.source === "repo" && <span className="tag">repo</span>}
          {s.manualOnly && <span className="tag">manual</span>}
          <span className="skill-desc">{s.description}</span>
        </button>
      ))}
    </div>
  );
}

/** Prompt box. Typing "/" at the start, or the Skills button, opens the skill picker. */
export function Composer({
  sessionId,
  busy,
  disabled,
  onSend,
  placeholder,
}: {
  sessionId?: string;
  busy: boolean;
  disabled?: boolean;
  onSend: (text: string, mode: "steer" | "followUp") => Promise<void>;
  placeholder?: string;
}) {
  const skills = useSkills(sessionId);
  const [text, setText] = useState("");
  const [picker, setPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = /^\/(?:skill:)?([\w-]*)$/.exec(text);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const send = async (mode: "steer" | "followUp") => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onSend(t, mode);
      setText("");
    } catch {
      // onSend reported it; keep the text so nothing is lost.
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const pick = (s: Skill) => {
    setText(`/skill:${s.name} `);
    setPicker(false);
    ref.current?.focus();
  };

  return (
    <div className="composer">
      {(picker || slash) && (
        <SkillPicker skills={skills} query={slash ? slash[1] : ""} onPick={pick} onClose={() => (slash ? setText("") : setPicker(false))} />
      )}
      <textarea
        ref={ref}
        className="composer-input"
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? (busy ? "Steer the agent… (it reads this after the current step)" : "Message the agent, or / for skills")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (picker || slash) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send(e.altKey ? "followUp" : "steer");
          }
        }}
      />
      <div className="composer-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => setPicker((p) => !p)} title="Choose a skill">
          ✦ Skills <span className="muted">({skills.length})</span>
        </button>
        <span className="muted small grow composer-hint">
          {busy ? "Enter steers now · Alt+Enter queues for after" : "Enter to send · Shift+Enter for a new line"}
        </span>
        {busy && (
          <button className="btn btn-sm" disabled={!text.trim() || sending} onClick={() => send("followUp")}>
            Queue
          </button>
        )}
        <button className="btn btn-primary btn-sm" disabled={!text.trim() || sending || disabled} onClick={() => send("steer")}>
          {busy ? "Steer" : "Send"}
        </button>
      </div>
    </div>
  );
}
