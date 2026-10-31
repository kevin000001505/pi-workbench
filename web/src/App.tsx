import { useEffect, useState } from "react";
import { Home } from "./pages/Home.tsx";
import { Issues } from "./pages/Issues.tsx";
import { NewSession } from "./pages/NewSession.tsx";
import { Repos } from "./pages/Repos.tsx";
import { Secrets } from "./pages/Secrets.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Ssh } from "./pages/Ssh.tsx";
import { SessionView } from "./session/SessionView.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useStore } from "./store.tsx";

export type Route =
  | { page: "home" }
  | { page: "session"; id: string }
  | {
      page: "new";
      repoId?: string;
      /** `owner/name#123`; when set the New Session form is pre-filled for that issue and its repo is locked. */
      issueRef?: string;
      prefillTitle?: string;
      prefillPrompt?: string;
      prefillBase?: string;
    }
  | { page: "repos" }
  | { page: "secrets" }
  | { page: "ssh" }
  | { page: "settings" }
  | { page: "issues"; repoId?: string; number?: number };

function parse(hash: string): Route {
  const [path, query] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query ?? "");
  const parts = path.split("/").filter(Boolean);
  const [page, a, b] = parts;
  switch (page) {
    case "session":
      return a ? { page: "session", id: a } : { page: "home" };
    case "new":
      return {
        page: "new",
        repoId: a ? decodeURIComponent(a) : undefined,
        issueRef: params.get("issue") ?? undefined,
        prefillTitle: params.get("title") ?? undefined,
        prefillPrompt: params.get("prompt") ?? undefined,
        prefillBase: params.get("base") ?? undefined,
      };
    case "issues":
      return {
        page: "issues",
        repoId: a ? decodeURIComponent(a) : undefined,
        number: b && /^\d+$/.test(b) ? Number(b) : undefined,
      };
    case "repos":
    case "secrets":
    case "ssh":
    case "settings":
      return { page };
    default:
      return { page: "home" };
  }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (hash: string) => {
  location.hash = hash;
};

export function App() {
  const route = useRoute();
  const { toasts, dismiss } = useStore();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [route]);

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <Sidebar route={route} onClose={() => setNavOpen(false)} />
      <button className="nav-toggle" aria-label="Menu" onClick={() => setNavOpen((o) => !o)}>
        ☰
      </button>
      <main className="main">
        {route.page === "home" && <Home />}
        {route.page === "session" && <SessionView key={route.id} id={route.id} />}
        {route.page === "new" && (
          <NewSession
            key={JSON.stringify(route)}
            repoId={route.repoId}
            issueRef={route.issueRef}
            prefillTitle={route.prefillTitle}
            prefillPrompt={route.prefillPrompt}
            prefillBase={route.prefillBase}
          />
        )}
        {route.page === "repos" && <Repos />}
        {route.page === "secrets" && <Secrets />}
        {route.page === "ssh" && <Ssh />}
        {route.page === "settings" && <Settings />}
        {route.page === "issues" && <Issues repoId={route.repoId} number={route.number} />}
      </main>
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.level}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
