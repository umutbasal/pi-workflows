import { describe, test, expect } from "bun:test";
import { formatRun } from "./index";
import type { WorkflowRun } from "./types";

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "abc-123-def",
    workflow: "test-workflow",
    status: "completed",
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
    steps: [],
    ...overrides,
  };
}

describe("formatRun", () => {
  test("includes run ID, workflow name, and status", () => {
    const output = formatRun(makeRun());

    expect(output).toContain("Run: abc-123-def");
    expect(output).toContain("Workflow: test-workflow");
    expect(output).toContain("Status: completed");
  });

  test("formats steps with index and status", () => {
    const output = formatRun(
      makeRun({
        steps: [
          { name: "discover", status: "completed", startedAt: 1000, completedAt: 3500 },
          { name: "analyze", status: "running", startedAt: 3500 },
        ],
      }),
    );

    expect(output).toContain("1. [completed] discover");
    expect(output).toContain("2. [running] analyze");
  });

  test("calculates duration for completed steps", () => {
    const output = formatRun(
      makeRun({
        steps: [
          { name: "fast", status: "completed", startedAt: 1000, completedAt: 2500 },
          { name: "slow", status: "completed", startedAt: 1000, completedAt: 11000 },
        ],
      }),
    );

    expect(output).toContain("fast (1.5s)");
    expect(output).toContain("slow (10.0s)");
  });

  test("does not show duration for steps without completedAt", () => {
    const output = formatRun(
      makeRun({
        steps: [{ name: "in-progress", status: "running", startedAt: 1000 }],
      }),
    );

    expect(output).toContain("[running] in-progress");
    expect(output).not.toContain("(");
  });

  test("includes phase label when present", () => {
    const output = formatRun(
      makeRun({
        steps: [
          { name: "step1", phase: "Discover", status: "completed", startedAt: 100, completedAt: 200 },
        ],
      }),
    );

    expect(output).toContain("(Discover)");
  });

  test("handles empty steps array", () => {
    const output = formatRun(makeRun({ steps: [] }));

    expect(output).toContain("Steps:");
    // Should not crash, just show the header
    const lines = output.split("\n");
    const stepsIdx = lines.findIndex((l) => l.includes("Steps:"));
    // Next line after "Steps:" should be empty or result section
    expect(stepsIdx).toBeGreaterThan(0);
  });

  test("includes result when present", () => {
    const output = formatRun(
      makeRun({
        result: { summary: "done", count: 42 },
      }),
    );

    expect(output).toContain("Result:");
    expect(output).toContain('"summary": "done"');
    expect(output).toContain('"count": 42');
  });

  test("omits result section when result is undefined", () => {
    const output = formatRun(makeRun({ result: undefined }));

    expect(output).not.toContain("Result:");
  });

  test("handles all workflow statuses", () => {
    for (const status of ["running", "completed", "failed", "cancelled"] as const) {
      const output = formatRun(makeRun({ status }));
      expect(output).toContain(`Status: ${status}`);
    }
  });
});
