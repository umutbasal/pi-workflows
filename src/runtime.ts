import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentFn,
  AgentOptions,
  LogFn,
  PipelineFn,
  WorkflowRuntime,
  WorkflowStep,
} from "./types";

export function createRuntime(
  ctx: ExtensionContext,
  onStep: (step: WorkflowStep) => void,
): WorkflowRuntime {
  const log: LogFn = (message) => {
    ctx.ui.notify(message, "info");
  };

  const agent: AgentFn = async (prompt: string, options?: AgentOptions) => {
    const step: WorkflowStep = {
      name: options?.label ?? prompt.slice(0, 60),
      phase: options?.phase,
      status: "running",
      startedAt: Date.now(),
    };
    onStep(step);

    const schemaInstruction = options?.schema
      ? `\n\nAfter completing the task, output your final answer as JSON matching this schema:\n${JSON.stringify(options.schema, null, 2)}\n\nReturn ONLY the JSON object, no markdown fences or extra text.`
      : "";

    try {
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: ctx.model,
      });

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

      await session.prompt(prompt + schemaInstruction);
      session.dispose();

      let result: any = responseText;
      if (options?.schema && responseText) {
        try {
          const cleaned = responseText
            .replace(/^```(?:json)?\s*/m, "")
            .replace(/\s*```\s*$/m, "")
            .trim();
          result = JSON.parse(cleaned);
        } catch {
          // keep as string if parse fails
        }
      }

      step.status = "completed";
      step.completedAt = Date.now();
      step.result = result;
      onStep(step);
      return result;
    } catch (err: any) {
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
      const tasks = results.map(async (entry, index) => {
        const input = entry._result;
        const item = entry._item;
        try {
          const output = await stage(input, item, index);
          return { _item: item, _result: output };
        } catch (err) {
          log(`Pipeline stage failed for item ${index}: ${err}`);
          return { _item: item, _result: undefined };
        }
      });
      results = await Promise.all(tasks);
    }

    return results.map((r) => r._result);
  };

  return { agent, log, pipeline, args: undefined };
}
