import { describe, expect, it, mock } from "bun:test";
import { listWorkflows, loadWorkflow } from "./loader";
import { createRuntime } from "./runtime";
import { listRuns, loadRun, saveRun } from "./store";
import type { WorkflowRun, WorkflowStep } from "./types";

const CWD = import.meta.dir.replace("/src", "");

describe("loader", () => {
  it("lists workflows from discovered dirs", async () => {
    const workflows = await listWorkflows(CWD);
    const names = workflows.map((w) => w.name);
    expect(names).toContain("hello");
  });

  it("includes source info", async () => {
    const workflows = await listWorkflows(CWD);
    const hello = workflows.find((w) => w.name === "hello");
    expect(hello).toBeDefined();
    expect(hello!.source).toBe("project");
    expect(hello!.dir).toContain(".pi-workflows");
  });

  it("returns empty for missing dirs", async () => {
    const workflows = await listWorkflows("/tmp/nonexistent-xyz-" + Date.now());
    expect(workflows).toEqual([]);
  });

  it("loads a workflow module", async () => {
    const mod = await loadWorkflow(CWD, "hello");
    expect(mod).not.toBeNull();
    expect(mod!.meta.name).toBe("hello");
    expect(typeof mod!.default).toBe("function");
  });

  it("returns null for missing workflow", async () => {
    const mod = await loadWorkflow(CWD, "nonexistent");
    expect(mod).toBeNull();
  });
});

describe("store", () => {
  const testRun: WorkflowRun = {
    runId: "test-run-001",
    workflow: "hello",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: [
      { name: "step1", status: "completed", startedAt: 1000, completedAt: 2000 },
      { name: "step2", status: "running", startedAt: 2000 },
    ],
  };

  it("saves and loads a run", async () => {
    await saveRun(CWD, testRun);
    const loaded = await loadRun(CWD, testRun.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("test-run-001");
    expect(loaded!.workflow).toBe("hello");
    expect(loaded!.steps).toHaveLength(2);
  });

  it("lists runs", async () => {
    const runs = await listRuns(CWD);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.find((r) => r.runId === "test-run-001")).toBeDefined();
  });

  it("returns null for missing run", async () => {
    const loaded = await loadRun(CWD, "nonexistent-id");
    expect(loaded).toBeNull();
  });
});

describe("runtime", () => {
  it("creates a runtime with agent, pipeline, log", () => {
    const mockCtx = {
      cwd: CWD,
      ui: { notify: mock(() => {}) },
      model: undefined,
    } as any;

    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(mockCtx, (step) => steps.push({ ...step }));

    expect(typeof runtime.agent).toBe("function");
    expect(typeof runtime.pipeline).toBe("function");
    expect(typeof runtime.log).toBe("function");
  });

  it("log calls ctx.ui.notify", () => {
    const notifyMock = mock(() => {});
    const mockCtx = {
      cwd: CWD,
      ui: { notify: notifyMock },
      model: undefined,
    } as any;

    const runtime = createRuntime(mockCtx, () => {});
    runtime.log("test message");

    expect(notifyMock).toHaveBeenCalledWith("test message", "info");
  });

  it("pipeline processes items through stages sequentially", async () => {
    const mockCtx = {
      cwd: CWD,
      ui: { notify: mock(() => {}) },
      model: undefined,
    } as any;

    const runtime = createRuntime(mockCtx, () => {});

    const results = await runtime.pipeline(
      [1, 2, 3],
      (n: number) => n * 2,
      (n: number) => n + 1,
    );

    expect(results).toEqual([3, 5, 7]);
  });

  it("pipeline handles errors gracefully", async () => {
    const mockCtx = {
      cwd: CWD,
      ui: { notify: mock(() => {}) },
      model: undefined,
    } as any;

    const runtime = createRuntime(mockCtx, () => {});

    const results = await runtime.pipeline(
      [1, 2, 3],
      (n: number) => {
        if (n === 2) throw new Error("fail");
        return n * 10;
      },
    );

    expect(results).toEqual([10, undefined, 30]);
  });
});
