import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { WorkflowStep } from "./types";

// Mock createAgentSession before importing runtime
const mockPrompt = mock((_prompt: string) => Promise.resolve());
const mockDispose = mock(() => {});
const mockSubscribe = mock((cb: (event: any) => void) => {
  // Store callback so tests can trigger events
  (mockSubscribe as any)._cb = cb;
});

mock.module("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mock(async (opts?: any) => ({
    session: {
      prompt: mockPrompt,
      subscribe: mockSubscribe,
      dispose: mockDispose,
    },
  })),
  defineTool: mock((config: any) => config),
}));

const { createRuntime } = await import("./runtime");

function makeCtx() {
  return {
    cwd: "/tmp/test",
    model: "test-model",
    ui: { notify: mock(() => {}) },
  } as any;
}

describe("pipeline", () => {
  test("returns empty array for empty items", async () => {
    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(makeCtx(), (s) => steps.push({ ...s }));

    const result = await runtime.pipeline([], (input) => input);
    expect(result).toEqual([]);
  });

  test("returns items unchanged when no stages provided", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    const result = await runtime.pipeline([1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  test("applies a single stage to all items", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    const result = await runtime.pipeline(
      [1, 2, 3],
      (input: number) => input * 2,
    );
    expect(result).toEqual([2, 4, 6]);
  });

  test("chains multiple stages sequentially", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    const result = await runtime.pipeline(
      [1, 2, 3],
      (input: number) => input + 10, // [11, 12, 13]
      (input: number) => input * 2,  // [22, 24, 26]
    );
    expect(result).toEqual([22, 24, 26]);
  });

  test("handles async stage functions", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    const result = await runtime.pipeline(
      ["a", "b"],
      async (input: string) => {
        await new Promise((r) => setTimeout(r, 1));
        return input.toUpperCase();
      },
    );
    expect(result).toEqual(["A", "B"]);
  });

  test("returns undefined for failed items without crashing", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    const result = await runtime.pipeline(
      [1, 2, 3],
      (input: number) => {
        if (input === 2) throw new Error("boom");
        return input * 10;
      },
    );
    expect(result).toEqual([10, undefined, 30]);
  });

  test("passes original item as second argument to stage", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    const result = await runtime.pipeline(
      ["hello", "world"],
      (input: string) => input.length,          // [5, 5]
      (input: number, item: string) => `${item}:${input}`, // uses original item
    );
    expect(result).toEqual(["hello:5", "world:5"]);
  });

  test("passes index as third argument to stage", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    const result = await runtime.pipeline(
      ["a", "b", "c"],
      (_input: string, _item: string, index: number) => index,
    );
    expect(result).toEqual([0, 1, 2]);
  });
});

describe("agent", () => {
  beforeEach(() => {
    mockPrompt.mockClear();
    mockDispose.mockClear();
    mockSubscribe.mockClear();
  });

  test("uses label as step name when provided", async () => {
    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(makeCtx(), (s) => steps.push({ ...s }));

    // Make prompt trigger the subscriber with a response
    mockPrompt.mockImplementationOnce(async () => {
      const cb = (mockSubscribe as any)._cb;
      cb({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "response" }],
        },
      });
    });

    await runtime.agent("Do something complex", { label: "my-step" });

    expect(steps[0]!.name).toBe("my-step");
  });

  test("falls back to prompt.slice(0, 60) when label is absent", async () => {
    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(makeCtx(), (s) => steps.push({ ...s }));

    const longPrompt = "A".repeat(100);
    mockPrompt.mockImplementationOnce(async () => {
      const cb = (mockSubscribe as any)._cb;
      cb({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      });
    });

    await runtime.agent(longPrompt);

    expect(steps[0]!.name).toBe("A".repeat(60));
  });

  test("when schema is provided, prompt includes emit_result instruction", async () => {
    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(makeCtx(), (s) => steps.push({ ...s }));
    const schema = { type: "object", properties: { x: { type: "number" } } };

    // With schema, the tool-use pattern is used.
    // The emit_result tool's execute will be called by the agent framework.
    // In our mock, we need to simulate the tool being called.
    mockPrompt.mockImplementationOnce(async (prompt: string) => {
      // Verify prompt contains the schema instruction
      expect(prompt).toContain("MUST call the `emit_result` tool");
      expect(prompt).toContain('"type": "object"');
      // Simulate: since we mocked defineTool, the tool execute won't be called.
      // The getResult() will return undefined, which is our fallback path.
    });

    await runtime.agent("compute x", { schema });

    // Should have step completed (fallback path since mock doesn't actually call tool)
    const lastStep = steps[steps.length - 1]!;
    expect(lastStep.status).toBe("completed");
  });

  test("does not include emit_result instruction when schema is undefined", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    mockPrompt.mockImplementationOnce(async (prompt: string) => {
      expect(prompt).not.toContain("emit_result");
      const cb = (mockSubscribe as any)._cb;
      cb({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      });
    });

    await runtime.agent("say hello");
  });

  test("returns text response when no schema is provided", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    mockPrompt.mockImplementationOnce(async () => {
      const cb = (mockSubscribe as any)._cb;
      cb({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the answer is 42" }],
        },
      });
    });

    const result = await runtime.agent("what is the answer?");
    expect(result).toBe("the answer is 42");
  });

  test("calls onStep with running status then completed status", async () => {
    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(makeCtx(), (s) => steps.push({ ...s }));

    mockPrompt.mockImplementationOnce(async () => {
      const cb = (mockSubscribe as any)._cb;
      cb({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
    });

    await runtime.agent("work", { label: "step1" });

    expect(steps.length).toBe(2);
    expect(steps[0]!.status).toBe("running");
    expect(steps[0]!.startedAt).toBeGreaterThan(0);
    expect(steps[1]!.status).toBe("completed");
    expect(steps[1]!.completedAt).toBeGreaterThan(0);
    expect(steps[1]!.result).toBe("done");
  });

  test("sets step to failed with error when createAgentSession throws", async () => {
    // Override for this test - re-mock to throw
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    (createAgentSession as any).mockImplementationOnce(async () => {
      throw new Error("connection failed");
    });

    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(makeCtx(), (s) => steps.push({ ...s }));

    const result = await runtime.agent("fail", { label: "failing-step" });

    expect(result).toBeUndefined();
    const lastStep = steps[steps.length - 1]!;
    expect(lastStep.status).toBe("failed");
    expect(lastStep.error).toBe("connection failed");
  });

  test("passes phase to WorkflowStep", async () => {
    const steps: WorkflowStep[] = [];
    const runtime = createRuntime(makeCtx(), (s) => steps.push({ ...s }));

    mockPrompt.mockImplementationOnce(async () => {
      const cb = (mockSubscribe as any)._cb;
      cb({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      });
    });

    await runtime.agent("work", { label: "s", phase: "Analyze" });

    expect(steps[0]!.phase).toBe("Analyze");
    expect(steps[1]!.phase).toBe("Analyze");
  });

  test("calls session.dispose() after successful prompt", async () => {
    const runtime = createRuntime(makeCtx(), () => {});

    mockPrompt.mockImplementationOnce(async () => {
      const cb = (mockSubscribe as any)._cb;
      cb({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      });
    });

    await runtime.agent("test");
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});

describe("log", () => {
  test("calls ctx.ui.notify with message and info level", () => {
    const ctx = makeCtx();
    const runtime = createRuntime(ctx, () => {});

    runtime.log("hello world");
    expect(ctx.ui.notify).toHaveBeenCalledWith("hello world", "info");
  });
});
