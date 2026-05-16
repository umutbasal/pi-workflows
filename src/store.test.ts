import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { saveRun, loadRun, listRuns } from "./store";
import type { WorkflowRun } from "./types";

let testDir: string;

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "test-run-001",
    workflow: "test-workflow",
    status: "completed",
    createdAt: 1000,
    updatedAt: 2000,
    steps: [],
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "store-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("saveRun", () => {
  test("creates .runs directory and writes valid JSON file", async () => {
    const run = makeRun();
    await saveRun(testDir, run);

    const filePath = join(testDir, ".pi-workflows/.runs", `${run.runId}.json`);
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.runId).toBe("test-run-001");
    expect(parsed.workflow).toBe("test-workflow");
    expect(parsed.status).toBe("completed");
  });

  test("overwrites existing run file on update", async () => {
    const run = makeRun();
    await saveRun(testDir, run);

    run.status = "failed";
    run.updatedAt = 3000;
    await saveRun(testDir, run);

    const loaded = await loadRun(testDir, run.runId);
    expect(loaded!.status).toBe("failed");
    expect(loaded!.updatedAt).toBe(3000);
  });

  test("preserves all fields including steps and result", async () => {
    const run = makeRun({
      steps: [
        { name: "step-1", status: "completed", startedAt: 100, completedAt: 200, result: { x: 1 } },
        { name: "step-2", status: "failed", startedAt: 200, error: "oops" },
      ],
      result: { output: "success" },
      args: { foo: "bar" },
    });

    await saveRun(testDir, run);
    const loaded = await loadRun(testDir, run.runId);

    expect(loaded!.steps).toHaveLength(2);
    expect(loaded!.steps[0]!.result).toEqual({ x: 1 });
    expect(loaded!.steps[1]!.error).toBe("oops");
    expect(loaded!.result).toEqual({ output: "success" });
    expect(loaded!.args).toEqual({ foo: "bar" });
  });
});

describe("loadRun", () => {
  test("returns null for non-existent runId", async () => {
    const result = await loadRun(testDir, "nonexistent-id");
    expect(result).toBeNull();
  });

  test("returns null when file contains invalid JSON", async () => {
    const runsDir = join(testDir, ".pi-workflows/.runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "corrupt.json"), "not json {{{");

    const result = await loadRun(testDir, "corrupt");
    expect(result).toBeNull();
  });

  test("correctly deserializes a previously saved run", async () => {
    const run = makeRun({
      runId: "load-test",
      status: "running",
      createdAt: 5000,
      updatedAt: 6000,
    });
    await saveRun(testDir, run);

    const loaded = await loadRun(testDir, "load-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("load-test");
    expect(loaded!.status).toBe("running");
    expect(loaded!.createdAt).toBe(5000);
    expect(loaded!.updatedAt).toBe(6000);
  });
});

describe("listRuns", () => {
  test("returns empty array when .runs directory does not exist", async () => {
    const result = await listRuns(testDir);
    expect(result).toEqual([]);
  });

  test("returns all valid runs sorted by updatedAt descending", async () => {
    await saveRun(testDir, makeRun({ runId: "old", updatedAt: 1000 }));
    await saveRun(testDir, makeRun({ runId: "new", updatedAt: 3000 }));
    await saveRun(testDir, makeRun({ runId: "mid", updatedAt: 2000 }));

    const result = await listRuns(testDir);
    expect(result).toHaveLength(3);
    expect(result[0]!.runId).toBe("new");
    expect(result[1]!.runId).toBe("mid");
    expect(result[2]!.runId).toBe("old");
  });

  test("filters out non-.json files", async () => {
    const runsDir = join(testDir, ".pi-workflows/.runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, ".DS_Store"), "binary stuff");
    await writeFile(join(runsDir, "readme.md"), "# runs");
    await saveRun(testDir, makeRun({ runId: "valid-run" }));

    const result = await listRuns(testDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.runId).toBe("valid-run");
  });

  test("skips corrupt JSON files gracefully", async () => {
    const runsDir = join(testDir, ".pi-workflows/.runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "corrupt.json"), "{{invalid");
    await saveRun(testDir, makeRun({ runId: "good-run" }));

    const result = await listRuns(testDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.runId).toBe("good-run");
  });
});
