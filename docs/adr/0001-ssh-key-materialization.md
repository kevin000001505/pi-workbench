# SSH keys materialized as files in the agent's home

The agent must `ssh` into registered hosts to fix code remotely. Secrets are encrypted at rest and never come back over the API, but unlike git (which takes a token via env), ssh wants a key file. We therefore let the workbench decrypt the referenced keys through `SecretStore` and write them as `~/.ssh/<name>` (mode 0600) in the agent's home, and regenerate `~/.ssh/config` wholesale from the saved hosts — on key/host changes and before every pi spawn. The container is dedicated, so the workbench owns `~/.ssh` there.

**Considered alternatives**: an ssh-agent the agent talks to (a long-lived daemon; the key still has to be decrypted somewhere; more moving parts); the agent assembling `ssh -i /path/key` commands itself (the key path then appears in prompts and transcripts, and the alias — the word you actually say — stops being the interface); raw ssh_config paste (breaks the key↔host link, no validation).

**Consequences**: a plaintext key file exists in the agent's home for the container's lifetime; the generated config carries `StrictHostKeyChecking accept-new` so non-interactive ssh never hangs on a fingerprint prompt; hand edits to `~/.ssh` are overwritten by the next save or spawn.
