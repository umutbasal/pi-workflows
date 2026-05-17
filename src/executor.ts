import type { WorkflowRuntime } from "./types";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function executeWorkflow(
  body: string,
  runtime: WorkflowRuntime,
  args: Record<string, unknown> | string | undefined,
): Promise<unknown> {
  const fn = new AsyncFunction(
    "agent",
    "pipeline",
    "parallel",
    "phase",
    "log",
    "args",
    body,
  );
  return fn(
    runtime.agent,
    runtime.pipeline,
    runtime.parallel,
    runtime.phase,
    runtime.log,
    args,
  );
}
