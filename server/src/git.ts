import { execFile } from "node:child_process";

/**
 * Answers git's credential requests for github.com with the GITHUB_TOKEN from the environment.
 * The image also installs it system-wide so the agent's own git commands use it.
 */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=${GITHUB_TOKEN:-$GH_TOKEN}"; }; f';

export type GitEnv = Record<string, string>;

export function git(cwd: string, args: string[], env: GitEnv = {}, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`, ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env, WORKBENCH_MASTER_KEY: "" },
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).toString().trim();
          reject(new Error(`git ${args[0]} failed: ${redact(msg)}`));
        } else resolve(stdout.toString());
      },
    );
  });
}

/** Drop tokens git may echo back inside URLs. */
export function redact(text: string) {
  return text.replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@").replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***");
}
