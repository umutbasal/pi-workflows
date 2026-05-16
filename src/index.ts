import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "crypto";
import { mkdir } from "fs/promises";
import { listWorkflows, loadWorkflow, getProjectWorkflowDir } from "./loader";
import { createRuntime } from "./runtime";
import { listRuns, loadRun, saveRun } from "./store";
import type { WorkflowRun, WorkflowStep } from "./types";

const WORKFLOW_PROMPT_GUIDELINES = [
  "When the user asks you to create a workflow, write a .js file in .pi/workflows/ (project-local) that exports `meta` and a default async function.",
  "Workflow scripts receive `{ agent, pipeline, log, args }`. Use `agent(prompt, opts?)` to spawn sub-agents that have full tool access (read, write, bash, grep, etc).",
  "Use `pipeline(items, ...stages)` to process items through stages. Each stage runs items concurrently, stages run sequentially.",
  "The `agent()` function returns the agent's text response. Pass `{ schema }` to get structured JSON back.",
  "Use `action: 'start'` to execute a workflow, `action: 'list'` to see available ones.",
  "Workflows are discovered from: .pi/workflows/, .agents/workflows/, .pi-workflows/ in project and ancestors, plus ~/.pi/agent/workflows/ and ~/.agents/workflows/ globally.",
  "When creating new workflows, always place them in .pi/workflows/ within the project root.",
];

const WORKFLOW_SCRIPT_TEMPLATE = `// Available runtime: { agent, pipeline, step, log, args }
//
// agent(prompt, opts?) - spawn a sub-agent with full tool access (read/write/bash/grep)
//   opts.label   - display label for tracking
//   opts.phase   - phase name for grouping
//   opts.schema  - JSON schema to get structured output
//   Returns: agent's response (string or parsed JSON if schema provided)
//
// pipeline(items, ...stages) - process items through stages
//   Each stage: (prevResult, item, index) => result
//   Items within a stage run concurrently, stages run sequentially
//
// step(name, phase, fn) - track a non-agent computation step
//   Wraps fn() with timing and status tracking in the run log
//   Returns: whatever fn() returns
//
// log(message) - show a notification
// args - parsed JSON from the tool call's args parameter
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
      const mod = await loadWorkflow(cwd, params.workflow);
      if (!mod) {
        const available = await listWorkflows(cwd);
        const projectDir = getProjectWorkflowDir(cwd);
        await mkdir(projectDir, { recursive: true });
        const hint =
          available.length > 0
            ? `\nAvailable: ${available.map((w) => w.name).join(", ")}`
            : `\nNo workflows found. Create a .js file in ${projectDir}`;
        return {
          content: [{
            type: "text",
            text: `Workflow "${params.workflow}" not found.${hint}\n\nTo create it, write a file at: ${projectDir}/${params.workflow}.js\n\nTemplate:\n${WORKFLOW_SCRIPT_TEMPLATE}`,
          }],
          details: {},
        };
      }

      let parsedArgs: Record<string, unknown> | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
        } catch {
          return { content: [{ type: "text", text: "Error: args must be valid JSON" }], details: {} };
        }
      }

      const run: WorkflowRun = {
        runId: randomUUID(),
        workflow: params.workflow,
        status: "running",
        args: parsedArgs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        steps: [],
      };

      await saveRun(cwd, run);
      ctx.ui.notify(`Starting workflow: ${mod.meta.name}`, "info");

      if (!mod.default) {
        run.status = "completed";
        run.updatedAt = Date.now();
        await saveRun(cwd, run);
        return {
          content: [{ type: "text", text: `Workflow ${mod.meta.name} has no default export to execute.` }],
          details: {},
        };
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
        return {
          content: [{
            type: "text",
            text: `Workflow "${mod.meta.name}" completed.\nRun ID: ${run.runId}\n\nResult:\n${summary}`,
          }],
          details: {},
        };
      } catch (err) {
        run.status = "failed";
        run.updatedAt = Date.now();
        await saveRun(cwd, run);
        return {
          content: [{
            type: "text",
            text: `Workflow "${mod.meta.name}" failed: ${err instanceof Error ? err.message : err}`,
          }],
          details: {},
        };
      }
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
        pi.sendUserMessage(
          `Use the workflow tool to start the "${workflowName}" workflow.`,
        );
        return;
      }

      const parts = args.split(/\s+/);
      const workflowName = parts[0];
      const workflowArgs = parts.slice(1).join(" ");

      pi.sendUserMessage(
        `Use the workflow tool to start the "${workflowName}" workflow${workflowArgs ? ` with args: ${workflowArgs}` : ""}.`,
      );
    },
  });
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
