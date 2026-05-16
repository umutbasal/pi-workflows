import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "crypto";
import { mkdir } from "fs/promises";
import { listWorkflows, loadWorkflow, getProjectWorkflowDir } from "./loader";
import { createRuntime } from "./runtime";
import { listRuns, loadRun, saveRun } from "./store";
import type { WorkflowRun, WorkflowStep } from "./types";

const WORKFLOW_PROMPT_GUIDELINES = [
  "Use `action: 'start'` to execute a workflow, `action: 'list'` to see available ones.",
  "Workflows are discovered from: .pi/workflows/, .agents/workflows/, .pi-workflows/ in project and ancestors, plus ~/.pi/agent/workflows/ and ~/.agents/workflows/ globally.",
  "When creating new workflows, always place them in .pi/workflows/ within the project root.",
];

const WORKFLOW_SCRIPT_TEMPLATE = `// Runtime: { agent, pipeline, step, log, args }
//
// agent(prompt, opts?) - sub-agent with full tool access (bash, read, write, grep, fetch, etc.)
//   Delegate ALL work to agent: file discovery, reading, searching, web, APIs, etc.
//   opts: { label, phase, schema }  — schema returns parsed JSON, otherwise string
//
// pipeline(items, ...stages) - concurrent processing
//   Stage 1: (item) => ...  |  Stage 2+: (prevResult, item, index) => ...
//
// step(name, phase, fn) - tracked JS computation (aggregation, filtering)
// log(message) - progress notification
// args - parsed JSON from workflow tool args
//
// ──── Minimal example ────
//
// export const meta = { name: "review", description: "Review files for bugs" };
//
// export default async function ({ agent, pipeline, step, log, args }) {
//   const files = await agent("Find all .ts source files, excluding tests", {
//     schema: { type: "array", items: { type: "string" } },
//   });
//   const results = await pipeline(files, (file) =>
//     agent(\`Read "\${file}" and find bugs\`, {
//       label: \`review:\${file}\`,
//       schema: { type: "object", properties: { file:{type:"string"}, bugs:{type:"array"} } },
//     })
//   );
//   return await step("report", "Report", () => ({
//     total: files.length,
//     issues: results.filter(r => r?.bugs?.length > 0),
//   }));
// }
`;



export default function piWorkflows(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const workflows = await listWorkflows(ctx.cwd);
    if (workflows.length > 0) {
      ctx.ui.setStatus("workflows", `${workflows.length} workflow(s)`);
    }
  });

  // Ensure project workflow dir exists when creating workflows
  pi.on("session_start", async (_event, ctx) => {
    const { mkdir } = await import("fs/promises");
    await mkdir(getProjectWorkflowDir(ctx.cwd), { recursive: true }).catch(() => {});
  });

  // Intercept CLI input: "pi workflow <name> [free-text args]"
  // Positional args arrive as separate prompt() calls. We accumulate and execute directly.
  let pendingWorkflowParts: string[] = [];
  let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCtx: ExtensionContext | null = null;

  const flushPendingWorkflow = async () => {
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
    if (pendingWorkflowParts.length < 2 || !pendingCtx) {
      // Not enough parts — re-send as normal message
      if (pendingWorkflowParts.length > 0 && pendingCtx) {
        pi.sendUserMessage(pendingWorkflowParts.join(" "));
      }
      pendingWorkflowParts = [];
      pendingCtx = null;
      return;
    }
    const name = pendingWorkflowParts[1];
    const rawArgs = pendingWorkflowParts.length > 2 ? pendingWorkflowParts.slice(2).join(" ") : undefined;
    const ctx = pendingCtx;
    pendingWorkflowParts = [];
    pendingCtx = null;
    const result = await executeWorkflow(name, rawArgs, ctx);
    pi.sendUserMessage(result, { deliverAs: "steer" });
  };

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();

    // Single message: "workflow http-discovery my-targets.txt 80,443"
    const workflowMatch = text.match(/^workflow\s+(\S+)(?:\s+(.+))?$/s);
    if (workflowMatch) {
      const [, name, rawArgs] = workflowMatch;
      const workflows = await listWorkflows(ctx.cwd);
      if (workflows.find((w) => w.name === name)) {
        pendingWorkflowParts = [];
        if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
        const result = await executeWorkflow(name, rawArgs, ctx);
        pi.sendUserMessage(result, { deliverAs: "steer" });
        return { action: "handled" as const };
      }
    }

    // Multi-message accumulation: first "workflow", then "http-discovery", then args
    if (text === "workflow" && pendingWorkflowParts.length === 0) {
      pendingWorkflowParts = ["workflow"];
      pendingCtx = ctx;
      pendingFlushTimer = setTimeout(flushPendingWorkflow, 150);
      return { action: "handled" as const };
    }

    if (pendingWorkflowParts.length > 0 && pendingWorkflowParts[0] === "workflow") {
      if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
      pendingWorkflowParts.push(text);
      pendingCtx = ctx;

      if (pendingWorkflowParts.length === 2) {
        const name = pendingWorkflowParts[1];
        const workflows = await listWorkflows(ctx.cwd);
        if (!workflows.find((w) => w.name === name)) {
          const combined = pendingWorkflowParts.join(" ");
          pendingWorkflowParts = [];
          pendingCtx = null;
          return { action: "transform" as const, text: combined };
        }
        // Wait for potential args
        pendingFlushTimer = setTimeout(flushPendingWorkflow, 150);
        return { action: "handled" as const };
      }

      // 3+ parts — flush immediately
      await flushPendingWorkflow();
      return { action: "handled" as const };
    }

    return { action: "continue" as const };
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: "Create, list, or execute JavaScript workflow scripts from .pi-workflows/",
    promptSnippet: "Create and execute JS workflow scripts that orchestrate multi-step agent pipelines",
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: Type.Object({
      workflow: Type.String({ description: "Name of the workflow to execute or create" }),
      args: Type.Optional(
        Type.String({ description: "JSON arguments to pass to the workflow" }),
      ),
      action: Type.Optional(
        Type.Union([
          Type.Literal("start"),
          Type.Literal("status"),
          Type.Literal("list"),
          Type.Literal("cancel"),
        ]),
      ),
      run_id: Type.Optional(
        Type.String({ description: "Run ID for status/cancel actions" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "start";
      const cwd = ctx.cwd;

      if (action === "list") {
        const workflows = await listWorkflows(cwd);
        const runs = await listRuns(cwd);
        const lines = ["Available workflows:"];
        if (workflows.length === 0) {
          lines.push(`  (none - create .js files in ${getProjectWorkflowDir(cwd)})`);
        } else {
          for (const w of workflows) {
            lines.push(`  - ${w.name} [${w.source}] ${w.dir}`);
          }
        }
        if (runs.length > 0) {
          lines.push("", "Recent runs:");
          for (const r of runs.slice(0, 10)) {
            lines.push(
              `  ${r.runId.slice(0, 8)} | ${r.workflow} | ${r.status} | ${new Date(r.updatedAt).toLocaleString()}`,
            );
          }
        }
        lines.push("", "Workflow script template:", WORKFLOW_SCRIPT_TEMPLATE);
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      }

      if (action === "status") {
        if (!params.run_id) {
          return { content: [{ type: "text", text: "Error: run_id required for status" }], details: {} };
        }
        const run = await loadRun(cwd, params.run_id);
        if (!run) {
          return { content: [{ type: "text", text: `Run ${params.run_id} not found` }], details: {} };
        }
        return { content: [{ type: "text", text: formatRun(run) }], details: {} };
      }

      if (action === "cancel") {
        if (!params.run_id) {
          return { content: [{ type: "text", text: "Error: run_id required for cancel" }], details: {} };
        }
        const run = await loadRun(cwd, params.run_id);
        if (!run) {
          return { content: [{ type: "text", text: `Run ${params.run_id} not found` }], details: {} };
        }
        run.status = "cancelled";
        run.updatedAt = Date.now();
        for (const step of run.steps) {
          if (step.status === "pending" || step.status === "running") {
            step.status = "cancelled";
          }
        }
        await saveRun(cwd, run);
        return { content: [{ type: "text", text: `Cancelled run ${run.runId}` }], details: {} };
      }

      // action === "start"
      const resultText = await executeWorkflow(params.workflow, params.args, ctx);
      return { content: [{ type: "text", text: resultText }], details: {} };
    },
  });

  pi.registerCommand("workflow", {
    description: "Run or manage workflow scripts",
    handler: async (args, ctx) => {
      if (!args || args === "list") {
        const workflows = await listWorkflows(ctx.cwd);
        if (workflows.length === 0) {
          ctx.ui.notify("No workflows found — ask me to create one!", "info");
          return;
        }
        const names = workflows.map((w) => `${w.name} [${w.source}]`);
        const selected = await ctx.ui.select("Select a workflow", names);
        if (!selected) return;
        const workflowName = selected.split(" [")[0];
        const result = await executeWorkflow(workflowName, undefined, ctx);
        pi.sendUserMessage(result, { deliverAs: "steer" });
        return;
      }

      // Split: first word is workflow name, rest is free-text args
      const spaceIdx = args.indexOf(" ");
      const workflowName = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
      const rawArgs = spaceIdx === -1 ? undefined : args.slice(spaceIdx + 1).trim() || undefined;

      const result = await executeWorkflow(workflowName, rawArgs, ctx);
      pi.sendUserMessage(result, { deliverAs: "steer" });
    },
  });
}

/**
 * Execute a workflow. If rawArgs is provided:
 *  - If valid JSON → use directly as args
 *  - Otherwise → use an AI agent step to interpret free-text into workflow params
 */
async function executeWorkflow(
  workflowName: string,
  rawArgs: string | undefined,
  ctx: ExtensionContext,
): Promise<string> {
  const cwd = ctx.cwd;
  const mod = await loadWorkflow(cwd, workflowName);

  if (!mod) {
    const available = await listWorkflows(cwd);
    const projectDir = getProjectWorkflowDir(cwd);
    await mkdir(projectDir, { recursive: true });
    const hint =
      available.length > 0
        ? `\nAvailable: ${available.map((w) => w.name).join(", ")}`
        : `\nNo workflows found. Create a .js file in ${projectDir}`;
    return `Workflow "${workflowName}" not found.${hint}`;
  }

  // Resolve args: JSON passthrough or AI-interpreted free text
  let parsedArgs: Record<string, unknown> | undefined;
  if (rawArgs) {
    // Try JSON first
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      // Not JSON — use AI to interpret the free text into params
      parsedArgs = await interpretArgsWithAI(rawArgs, mod, ctx);
    }
  }

  const run: WorkflowRun = {
    runId: randomUUID(),
    workflow: workflowName,
    status: "running",
    args: parsedArgs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: [],
  };

  await saveRun(cwd, run);
  ctx.ui.notify(`Starting workflow: ${mod.meta.name}${parsedArgs ? ` with args: ${JSON.stringify(parsedArgs)}` : ""}`, "info");

  if (!mod.default) {
    run.status = "completed";
    run.updatedAt = Date.now();
    await saveRun(cwd, run);
    return `Workflow ${mod.meta.name} has no default export to execute.`;
  }

  const steps: WorkflowStep[] = [];
  const runtime = createRuntime(ctx, (step) => {
    const existing = steps.find(
      (s) => s.name === step.name && s.startedAt === step.startedAt,
    );
    if (existing) {
      Object.assign(existing, step);
    } else {
      steps.push({ ...step });
    }
    run.steps = steps;
    run.updatedAt = Date.now();
    saveRun(cwd, run).catch(() => {});
  });
  runtime.args = parsedArgs;

  try {
    const result = await mod.default(runtime);
    run.status = "completed";
    run.result = result;
    run.updatedAt = Date.now();
    await saveRun(cwd, run);

    const summary = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return `Workflow "${mod.meta.name}" completed.\nRun ID: ${run.runId}\n\nResult:\n${summary}`;
  } catch (err) {
    run.status = "failed";
    run.updatedAt = Date.now();
    await saveRun(cwd, run);
    return `Workflow "${mod.meta.name}" failed: ${err instanceof Error ? err.message : err}`;
  }
}

/**
 * Use an AI agent to interpret free-text args into structured params
 * based on the workflow's source code / meta.
 */
async function interpretArgsWithAI(
  rawText: string,
  mod: { meta: { name: string; description?: string }; source?: string },
  ctx: ExtensionContext,
): Promise<Record<string, unknown>> {
  const { createAgentSession, defineTool } = await import("@earendil-works/pi-coding-agent");

  let captured: Record<string, unknown> = {};

  const emitTool = defineTool({
    name: "emit_params",
    label: "Emit Params",
    description: "Emit the extracted workflow parameters as a JSON object. Call this exactly once.",
    parameters: Type.Object({
      params: Type.Record(Type.String(), Type.Any(), {
        description: "Extracted key-value parameters for the workflow",
      }),
    }),
    execute: async (_id, p: any) => {
      captured = p.params ?? {};
      return { content: [{ type: "text" as const, text: "OK" }], details: {}, terminate: true };
    },
  });

  const prompt = `You are a parameter extraction helper. A user wants to run a workflow and provided free-text arguments.

Workflow: "${mod.meta.name}"
${mod.meta.description ? `Description: ${mod.meta.description}` : ""}
${mod.source ? `\nWorkflow source:\n\`\`\`\n${mod.source}\n\`\`\`` : ""}

User's input: "${rawText}"

Look at what parameters the workflow expects (check args?.xxx patterns in the source) and extract meaningful values from the user's free-text input. Map what the user said to the expected parameter names.

Call emit_params with the extracted parameters as a JSON object.`;

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model: ctx.model,
    customTools: [emitTool],
  });

  await session.prompt(prompt);
  session.dispose();

  return captured;
}

export function formatRun(run: WorkflowRun): string {
  const lines = [
    `Run: ${run.runId}`,
    `Workflow: ${run.workflow}`,
    `Status: ${run.status}`,
    `Created: ${new Date(run.createdAt).toLocaleString()}`,
    `Updated: ${new Date(run.updatedAt).toLocaleString()}`,
    "",
    "Steps:",
  ];
  for (let i = 0; i < run.steps.length; i++) {
    const s = run.steps[i]!;
    const duration =
      s.startedAt && s.completedAt
        ? ` (${((s.completedAt - s.startedAt) / 1000).toFixed(1)}s)`
        : "";
    lines.push(`  ${i + 1}. [${s.status}]${s.phase ? ` (${s.phase})` : ""} ${s.name}${duration}`);
  }
  if (run.result) {
    lines.push("", "Result:", JSON.stringify(run.result, null, 2));
  }
  return lines.join("\n");
}
