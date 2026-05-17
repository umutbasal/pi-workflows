import { createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
  AgentFn,
  AgentOptions,
  LogFn,
  ParallelFn,
  PhaseFn,
  PipelineFn,
  WorkflowRuntime,
  WorkflowStep,
} from "./types";

/**
 * Create a custom tool that forces the model to emit structured output
 * matching a JSON schema. The tool's parameters ARE the output schema,
 * so Claude's tool-calling mechanism validates the JSON for us.
 *
 * How this works:
 * 1. We define an `emit_result` tool whose parameters match the desired output schema
 * 2. The model MUST call this tool to provide its answer (enforced via prompt instructions)
 * 3. The pi agent framework validates the tool arguments against the TypeBox schema
 *    BEFORE calling execute() — if validation fails, an error tool result is returned
 *    to the model and it retries automatically
 * 4. On successful validation, execute() captures the params and sets terminate:true
 *    to stop the agent loop
 *
 * This is equivalent to `toolChoice: { type: "tool", name: "emit_result" }` but
 * works within pi's agent framework which doesn't expose toolChoice directly.
 *
 * IMPORTANT: Claude's tool API requires parameters to be a JSON object at the top
 * level. If the user schema is non-object (array, string, etc.), we wrap it in
 * { type: "object", properties: { result: <schema> }, required: ["result"] }
 * and unwrap the `.result` field after capture.
 */
function createEmitResultTool(schema: Record<string, unknown>) {
  let captured: unknown = undefined;

  // Claude requires tool parameters to be an object at the top level.
  // Wrap non-object schemas in an envelope.
  const isTopLevelObject = schema.type === "object";
  const toolSchema = isTopLevelObject
    ? schema
    : {
        type: "object",
        required: ["result"],
        properties: {
          result: schema,
        },
      };

  const tool = defineTool({
    name: "emit_result",
    label: "Emit Result",
    description:
      "Emit your structured analysis result. You MUST call this tool exactly once " +
      "with your final answer after completing your analysis. Do not output the " +
      "result as text — always use this tool." +
      (isTopLevelObject
        ? ""
        : " Pass your result in the 'result' parameter."),
    parameters: Type.Unsafe(toolSchema),
    execute: async (_toolCallId, params: any) => {
      // Unwrap the envelope if we wrapped it
      captured = isTopLevelObject ? params : params.result;
      return {
        content: [{ type: "text" as const, text: "Result captured." }],
        details: {},
        terminate: true,
      };
    },
  });

  return {
    tool,
    getResult: () => captured,
  };
}

export function createRuntime(
  ctx: ExtensionContext,
  onStep: (step: WorkflowStep) => void,
  signal?: AbortSignal,
): WorkflowRuntime {
  let currentPhase: string | undefined;

  const log: LogFn = (message) => {
    ctx.ui.notify(message, "info");
  };

  const phase: PhaseFn = (name: string) => {
    currentPhase = name;
  };

  const agent: AgentFn = async (prompt: string, options?: AgentOptions) => {
    // Check if already cancelled before starting
    if (signal?.aborted) {
      throw new Error("Workflow cancelled");
    }

    const step: WorkflowStep = {
      name: options?.label ?? prompt.slice(0, 60),
      phase: options?.phase ?? currentPhase,
      status: "running",
      startedAt: Date.now(),
    };
    onStep(step);

    try {
      // When a schema is provided, use tool-use pattern for reliable structured output.
      // The emit_result tool's parameters ARE the schema, so the model's tool-calling
      // mechanism validates the JSON. If validation fails, the framework returns an
      // error tool result and the model retries automatically.
      if (options?.schema) {
        const { tool: emitResultTool, getResult } = createEmitResultTool(options.schema);

        const { session } = await createAgentSession({
          cwd: ctx.cwd,
          model: ctx.model,
          customTools: [emitResultTool],
        });

        // Abort the session when the signal fires
        const abortHandler = () => { session.abort(); session.dispose(); };
        signal?.addEventListener("abort", abortHandler, { once: true });

        const isTopLevelObject = options.schema.type === "object";
        const schemaPrompt =
          `${prompt}\n\n` +
          `---\n` +
          `IMPORTANT: After completing your analysis, you MUST call the \`emit_result\` tool ` +
          `with your structured findings. Do NOT write the result as text output.\n` +
          (isTopLevelObject
            ? `Call emit_result with parameters matching this schema:\n`
            : `Call emit_result with a single "result" parameter matching this schema:\n`) +
          `${JSON.stringify(options.schema, null, 2)}`;

        try {
          await session.prompt(schemaPrompt);
        } finally {
          signal?.removeEventListener("abort", abortHandler);
          session.dispose();
        }

        // Check if cancelled after the prompt
        if (signal?.aborted) {
          step.status = "cancelled";
          step.completedAt = Date.now();
          onStep(step);
          throw new Error("Workflow cancelled");
        }

        const result = getResult();
        if (result !== undefined) {
          step.status = "completed";
          step.completedAt = Date.now();
          step.result = result;
          onStep(step);
          return result;
        }

        // Fallback: tool wasn't called. This shouldn't happen with terminate:true
        // but handle gracefully.
        step.status = "completed";
        step.completedAt = Date.now();
        step.error = "emit_result tool was not called";
        onStep(step);
        return undefined;
      }

      // No schema: standard text response mode
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: ctx.model,
      });

      // Abort the session when the signal fires
      const abortHandler = () => { session.abort(); session.dispose(); };
      signal?.addEventListener("abort", abortHandler, { once: true });

      let responseText = "";
      session.subscribe((event) => {
        if (event.type === "message_end" && "message" in event) {
          const msg = event.message as any;
          if (msg?.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text") {
                responseText = block.text;
              }
            }
          }
        }
      });

      try {
        await session.prompt(prompt);
      } finally {
        signal?.removeEventListener("abort", abortHandler);
        session.dispose();
      }

      // Check if cancelled after the prompt
      if (signal?.aborted) {
        step.status = "cancelled";
        step.completedAt = Date.now();
        onStep(step);
        throw new Error("Workflow cancelled");
      }

      step.status = "completed";
      step.completedAt = Date.now();
      step.result = responseText;
      onStep(step);
      return responseText;
    } catch (err: any) {
      if (signal?.aborted) {
        step.status = "cancelled";
        step.completedAt = Date.now();
        step.error = "Cancelled";
        onStep(step);
        throw new Error("Workflow cancelled");
      }
      step.status = "failed";
      step.completedAt = Date.now();
      step.error = err?.message ?? String(err);
      onStep(step);
      return undefined;
    }
  };

  const pipeline: PipelineFn = async (items, ...stages) => {
    let results: any[] = items.map((item) => ({ _item: item, _result: item }));

    for (const stage of stages) {
      // Check cancellation between stages
      if (signal?.aborted) {
        throw new Error("Workflow cancelled");
      }

      const tasks = results.map(async (entry, index) => {
        const input = entry._result;
        const item = entry._item;
        try {
          if (signal?.aborted) {
            throw new Error("Workflow cancelled");
          }
          const output = await stage(input, item, index);
          return { _item: item, _result: output };
        } catch (err) {
          if (signal?.aborted) {
            throw new Error("Workflow cancelled");
          }
          log(`Pipeline stage failed for item ${index}: ${err}`);
          return { _item: item, _result: undefined };
        }
      });
      results = await Promise.all(tasks);
    }

    return results.map((r) => r._result);
  };

  const parallel: ParallelFn = async (thunks) => {
    if (signal?.aborted) {
      throw new Error("Workflow cancelled");
    }
    return Promise.all(thunks.map((thunk) => thunk()));
  };

  return { agent, log, phase, parallel, pipeline };
}
