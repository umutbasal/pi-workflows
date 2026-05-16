import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { dirname, join, parse, resolve } from "path";
import type { WorkflowModule } from "./types";

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

export async function loadWorkflow(
  cwd: string,
  name: string,
): Promise<(WorkflowModule & { source?: string }) | null> {
  const dirs = await getAllWorkflowDirs(cwd);
  const { readFile } = await import("fs/promises");

  for (const dir of dirs) {
    for (const ext of EXTENSIONS) {
      const path = join(dir, `${name}${ext}`);
      try {
        const mod = await import(path);
        if (!mod.meta?.name) return null;
        // Read source for AI param extraction
        let source: string | undefined;
        try { source = await readFile(path, "utf-8"); } catch {}
        return { ...mod, source } as WorkflowModule & { source?: string };
      } catch {
        continue;
      }
    }
  }

  return null;
}
