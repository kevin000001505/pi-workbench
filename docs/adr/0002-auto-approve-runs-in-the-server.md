# Auto-approve runs in the server, not the pi extension

Auto-approve needs the reviewer's API key (Anthropic or OpenAI) and the Jev token. The extension already sends every permission to the server as a `{"wb": "permission"}` dialog, so the server judges it in `onUiRequest`: it calls the risk judge, then the reviewer if needed, and answers the dialog with `extension_ui_response`, as a user click would. The keys go through `SecretStore` and are never in a pi process's environment. The extension changes in one place only: it recognizes a reviewer deny (a `{"wb": "deny"}` value) and tells the agent the reviewer denied the call, not the user.

**Considered alternatives**: judging inside the extension before `ctx.ui.select` (one less hop, but the keys would then sit in pi's env, where the agent's own `bash` can read them with `env`, which is the very agent being judged); a separate sidecar service (one more container and auth hop for no gain).

**Consequences**: the permission card exists from the start, marked as being reviewed, and a user click wins over a pending review; when the judge or reviewer fails, the card just stays for the user; auto-allows are always single-call (never "Allow for this session"), so the extension's per-session allow set is only changed by the user.
