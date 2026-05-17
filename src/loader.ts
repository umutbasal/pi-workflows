import { readFile, readdir, stat } from "fs/promises";
import { homedir } from "os";
import { dirname, join, parse, resolve } from "path";
import type { WorkflowMeta, WorkflowModule } from "./types";

const EXTENSIONS = [".js", ".ts", ".mjs", ".mts"];

const GLOBAL_DIRS = [
  join(homedir(), ".pi", "agent", "workflows"),
  join(homedir(), ".agents", "workflows"),
];

const PROJECT_DIR_NAMES = [
  ".pi/workflows",
  ".agents/workflows",
  ".pi-workflows",
];

export function getProjectWorkflowDir(cwd: string): string {
  return join(cwd, ".pi", "workflows");
}

async function findGitRoot(cwd: string): Promise<string | null> {
  let dir = resolve(cwd);
  while (true) {
    try {
      const s = await stat(join(dir, ".git"));
      if (s.isDirectory() || s.isFile()) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function discoverProjectDirs(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  const root = (await findGitRoot(cwd)) ?? "/";
  let dir = resolve(cwd);

  while (true) {
    for (const name of PROJECT_DIR_NAMES) {
      dirs.push(join(dir, name));
    }
    if (dir === root || dir === "/") break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirs;
}

export async function getAllWorkflowDirs(cwd: string): Promise<string[]> {
  const projectDirs = await discoverProjectDirs(cwd);
  return [...projectDirs, ...GLOBAL_DIRS];
}

async function listDir(dir: string): Promise<{ name: string; dir: string }[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => EXTENSIONS.includes(parse(f).ext.toLowerCase()))
      .map((f) => ({ name: parse(f).name, dir }));
  } catch {
    return [];
  }
}

export async function listWorkflows(
  cwd: string,
): Promise<{ name: string; dir: string; source: "project" | "global" }[]> {
  const dirs = await getAllWorkflowDirs(cwd);
  const seen = new Set<string>();
  const results: { name: string; dir: string; source: "project" | "global" }[] = [];

  for (const dir of dirs) {
    const isGlobal = GLOBAL_DIRS.includes(dir);
    const entries = await listDir(dir);
    for (const entry of entries) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      results.push({ name: entry.name, dir: entry.dir, source: isGlobal ? "global" : "project" });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function extractMeta(source: string): WorkflowMeta | null {
  const match = source.match(/export\s+const\s+meta\s*=\s*/);
  if (!match) return null;

  const start = match.index! + match[0].length;
  if (source[start] !== "{") return null;

  let depth = 0;
  let end = start;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  const literal = source.slice(start, end);
  try {
    const meta = new Function(`return (${literal})`)() as WorkflowMeta;
    if (!meta?.name) return null;
    return meta;
  } catch {
    return null;
  }
}

export function extractBody(source: string): string {
  return source.replace(/export\s+const\s+meta\s*=\s*\{[^]*?\n\};?\s*/, "");
}

export function extractArgsHint(source: string): string | undefined {
  const match = source.match(/\/\/\s*args\s*:\s*(.+)/i);
  if (!match) return undefined;
  return match[1].trim();
}

export async function loadWorkflow(
  cwd: string,
  name: string,
): Promise<WorkflowModule | null> {
  const dirs = await getAllWorkflowDirs(cwd);

  for (const dir of dirs) {
    for (const ext of EXTENSIONS) {
      const path = join(dir, `${name}${ext}`);
      try {
        const source = await readFile(path, "utf-8");
        const meta = extractMeta(source);
        if (!meta) continue;
        const body = extractBody(source);
        return { meta, body };
      } catch {
        continue;
      }
    }
  }

  return null;
}
