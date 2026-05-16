import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { WorkflowRun } from "./types";

const RUNS_DIR = ".pi-workflows/.runs";

function runsDir(cwd: string): string {
  return join(cwd, RUNS_DIR);
}

function runPath(cwd: string, runId: string): string {
  return join(runsDir(cwd), `${runId}.json`);
}

export async function saveRun(cwd: string, run: WorkflowRun): Promise<void> {
  const dir = runsDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(runPath(cwd, run.runId), JSON.stringify(run, null, 2) + "\n");
}

export async function loadRun(
  cwd: string,
  runId: string,
): Promise<WorkflowRun | null> {
  try {
    const data = await readFile(runPath(cwd, runId), "utf-8");
    return JSON.parse(data) as WorkflowRun;
  } catch {
    return null;
  }
}

export async function listRuns(cwd: string): Promise<WorkflowRun[]> {
  let files: string[];
  try {
    files = await readdir(runsDir(cwd));
  } catch {
    return [];
  }

  const runs = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadRun(cwd, f.replace(".json", ""))),
  );

  return runs
    .filter((r): r is WorkflowRun => r !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
