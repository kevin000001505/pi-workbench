import fs from "node:fs";
import path from "node:path";

export type Skill = {
  name: string;
  description: string;
  /** "global" for the image's skills, "repo" for the repo's own .agents/skills or .pi/skills. */
  source: "global" | "repo";
  /** Hidden from the model; only runs when the user types /skill:name. */
  manualOnly: boolean;
  path: string;
};

/** Parse the YAML-ish frontmatter skills use: `key: value`, quoted values and `>`/`|` blocks. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-" || value === "") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith("|") ? "\n" : " ");
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[kv[1]] = value;
  }
  return out;
}

/** Every directory under `root` that holds a SKILL.md, recursively. */
export function scanSkills(root: string, source: Skill["source"]): Skill[] {
  const skills: Skill[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      const file = path.join(dir, "SKILL.md");
      const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
      if (fm.name && fm.description) {
        skills.push({
          name: fm.name,
          description: fm.description,
          source,
          manualOnly: fm["disable-model-invocation"] === "true",
          path: file,
        });
      }
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return skills;
}

/** The skills a session in `cwd` can use: the repo's own first (pi keeps the first on a name clash). */
export function listSkills(globalDir: string, cwd?: string): Skill[] {
  const repo = cwd
    ? [...scanSkills(path.join(cwd, ".agents", "skills"), "repo"), ...scanSkills(path.join(cwd, ".pi", "skills"), "repo")]
    : [];
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const s of [...repo, ...scanSkills(globalDir, "global")]) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
