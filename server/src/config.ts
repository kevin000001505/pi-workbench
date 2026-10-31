import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(appRoot, ".data"));

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir,
  dbFile: path.join(dataDir, "workbench.db"),
  /** pi's agent dir (PI_CODING_AGENT_DIR): models.json, settings.json, trust, auth. Regenerated from the db. */
  piAgentDir: path.join(dataDir, "pi-agent"),
  /** pi session JSONL files, so a session can resume after its process exits. */
  piSessionsDir: path.join(dataDir, "pi-sessions"),
  /** The workbench user's home: where `~/.ssh` is materialized for the agent (ADR 0001). */
  agentHome: process.env.HOME ? path.resolve(process.env.HOME) : os.homedir(),
  reposDir: path.join(dataDir, "repos"),
  worktreesDir: path.join(dataDir, "worktrees"),
  piBin: process.env.PI_BIN ?? "pi",
  /** Global skills baked into the image (mattpocock/skills at a pinned commit). */
  skillsDir: path.resolve(process.env.SKILLS_DIR ?? path.join(appRoot, ".skills")),
  extensionPath: path.resolve(process.env.PI_EXTENSION ?? path.join(appRoot, "pi-extension", "workbench.ts")),
  webDir: path.resolve(process.env.WEB_DIR ?? path.join(appRoot, "web", "dist")),
  masterKey: process.env.WORKBENCH_MASTER_KEY ?? "",
  githubApi: process.env.GITHUB_API_URL ?? "https://api.github.com",
  /** Where repos are cloned from; tests point it at local bare repos. */
  githubCloneBase: process.env.GITHUB_CLONE_BASE ?? "https://github.com",
  defaults: {
    baseUrl: process.env.LLM_BASE_URL ?? "http://host.docker.internal:8080/v1",
    modelId: process.env.LLM_MODEL ?? "Qwen3.8-27B-radiance",
    contextWindow: Number(process.env.LLM_CONTEXT_WINDOW ?? 262144),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 32768),
  },
};

/** The marker file setup-matt-pocock-skills writes; its absence means the repo still needs setup. */
export const SETUP_MARKER = "docs/agents/issue-tracker.md";
export const SETUP_SKILL = "setup-matt-pocock-skills";
export const PROVIDER_ID = "workbench";
