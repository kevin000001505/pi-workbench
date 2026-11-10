import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { StoreProvider } from "./store.tsx";
// Terrazzo's faces, bundled so the UI makes no third-party font request: Syne 700 for heads,
// Onest 400/500/700 for everything else, JetBrains Mono 400 for code, issue numbers and counts.
import "@fontsource/syne/700.css";
import "@fontsource/onest/400.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
);
