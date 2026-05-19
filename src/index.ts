import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "crypto";
import { mkdir } from "fs/promises";
import { startDashboard } from "./dashboard";
import { executeWorkflow } from "./executor";
import { listWorkflows, loadWorkflow, getProjectWorkflowDir, extractArgsHint } from "./loader";
import { createRuntime } from "./runtime";
import { listRuns, loadRun, saveRun } from "./store";
import type { WorkflowRun, WorkflowStep } from "./types";
import type { WorkflowActivity } from "./activity";
import { WorkflowWidget } from "./ui/widget";
import type { UICtx } from "./ui/widget";

const WORKFLOW_PROMPT_GUIDELINES = [
  "Use `action: 'start'` to execute a workflow, `action: 'list'` to see available ones.",
  "Workflows are discovered from: .pi/workflows/, .agents/workflows/, .pi-workflows/ in project and ancestors, plus ~/.pi/agent/workflows/ and ~/.agents/workflows/ globally.",
  "When creating new workflows, always place them in .pi/workflows/ within the project root.",
  "When a user message says 'with args: ...', pass the rest of the text as the `args` parameter to the workflow tool. It can be JSON or a free-form prompt string.",
  "SANDBOX: Workflow scripts run in a sandboxed environment. Only these globals are available: agent(), pipeline(), parallel(), phase(), log(), args, and standard JS (Array, Object, JSON, Math, String, Promise, etc.). require(), import(), process, fs, path, child_process, and all Node.js built-ins are NOT available. For file I/O, shell commands, or system access, delegate to agent().",
];

const WORKFLOW_SCRIPT_TEMPLATE = `// Globals: agent, pipeline, parallel, phase, log, args
//
// SANDBOX: This is a sandboxed runtime. You CANNOT use require(), import(), process,
// Node.js built-ins, or any external packages. Only the globals below are available.
// For file discovery, shell commands, or system access — delegate to agent().
//
// agent(prompt, opts?) - sub-agent with full tool access (bash, read, write, grep, fetch, etc.)
//   Delegate ALL work to agent: file discovery, reading, searching, web, APIs, etc.
//   opts: { label, phase, schema }  — schema returns parsed JSON, otherwise string
//
// pipeline(items, ...steps) - maps items through sequential processing steps
//   Step 1: (item) => ...  |  Step 2+: (prevResult, originalItem) => ...
//
// parallel(thunks) - runs array of thunks concurrently
//   parallel([() => agent(...), () => agent(...)])
//   parallel(items.map(item => () => agent(promptFor(item), opts)))
//
// phase(name) - marks current execution phase (for progress tracking/UI)
// log(message) - progress notification
// args - parsed JSON from workflow tool args
//
// ──── Minimal example ────
//
// export const meta = {
//   name: "review",
//   description: "Review files for bugs",
//   phases: [
//     { title: "Discover", detail: "find source files" },
//     { title: "Review", detail: "review each file" },
//   ],
// };
//
// phase("Discover");
// const files = await agent("Find all .ts source files, excluding tests", {
//   schema: { type: "array", items: { type: "string" } },
// });
//
// phase("Review");
// const results = await pipeline(files,
//   (file) => agent(\`Read "\${file}" and find bugs\`, {
//     label: \`review:\${file}\`,
//     schema: { type: "object", properties: { file:{type:"string"}, bugs:{type:"array"} } },
//   })
// );
// return { total: files.length, issues: results.filter(r => r?.bugs?.length > 0) };
`;



export default function piWorkflows(pi: ExtensionAPI) {
  let currentRun: WorkflowRun | null = null;
  const activities = new Map<string, WorkflowActivity>();
  let workflowWidget: WorkflowWidget | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const { mkdir } = await import("fs/promises");
    await mkdir(getProjectWorkflowDir(ctx.cwd), { recursive: true }).catch(() => {});
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    if (workflowWidget && currentRun) {
      workflowWidget.setUICtx(ctx.ui as UICtx);
      workflowWidget.onTurnStart();
    }
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
        Type.String({ description: "Arguments to pass to the workflow (JSON object or free-form string)" }),
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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

      let parsedArgs: Record<string, unknown> | string | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
        } catch {
          parsedArgs = params.args;
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

      currentRun = run;
      activities.clear();

      workflowWidget = new WorkflowWidget(run, activities);
      workflowWidget.setUICtx(ctx.ui as UICtx);
      workflowWidget.ensureTimer();

      const onActivityChange = (stepName: string, activity: WorkflowActivity) => {
        activities.set(stepName, activity);
        workflowWidget!.update();
      };

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
        workflowWidget!.update();
      }, signal, onActivityChange);

      try {
        const result = await executeWorkflow(mod.body, runtime, parsedArgs);
        run.status = "completed";
        run.result = result;
        run.updatedAt = Date.now();
        await saveRun(cwd, run);

        for (const step of steps) {
          if (step.completedAt) workflowWidget!.markFinished(step.name);
        }
        workflowWidget!.update();

        const summary = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return {
          content: [{
            type: "text",
            text: `Workflow "${mod.meta.name}" completed.\nRun ID: ${run.runId}\n\nResult:\n${summary}`,
          }],
          details: {},
        };
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.message === "Workflow cancelled")) {
          run.status = "cancelled";
          run.updatedAt = Date.now();
          for (const step of run.steps) {
            if (step.status === "pending" || step.status === "running") {
              step.status = "cancelled";
            }
          }
          await saveRun(cwd, run);
          workflowWidget?.dispose();
          workflowWidget = null;
          currentRun = null;
          return {
            content: [{
              type: "text",
              text: `Workflow "${mod.meta.name}" cancelled.\nRun ID: ${run.runId}`,
            }],
            details: {},
          };
        }
        run.status = "failed";
        run.updatedAt = Date.now();
        await saveRun(cwd, run);
        workflowWidget?.dispose();
        workflowWidget = null;
        currentRun = null;
        return {
          content: [{
            type: "text",
            text: `Workflow "${mod.meta.name}" failed: ${err instanceof Error ? err.message : err}`,
          }],
          details: {},
        };
      } finally {
        setTimeout(() => {
          workflowWidget?.dispose();
          workflowWidget = null;
          currentRun = null;
        }, 3000);
      }
    },
  });

  let dashboardInstance: { url: string; stop: () => void } | null = null;

  pi.registerCommand("dashboard", {
    description: "Open the workflow runs dashboard",
    handler: async (_args, ctx) => {
      if (dashboardInstance) {
        ctx.ui.notify(`Dashboard already running at ${dashboardInstance.url}`, "info");
        return;
      }
      dashboardInstance = await startDashboard(ctx.cwd);
      ctx.ui.notify(`Dashboard started at ${dashboardInstance.url}`, "info");
    },
  });

  pi.registerCommand("workflow-steps", {
    description: "View running workflow steps and their conversations",
    handler: async (_args, ctx) => {
      if (!currentRun || currentRun.steps.length === 0) {
        ctx.ui.notify("No workflow is currently running.", "info");
        return;
      }

      const stepOptions = currentRun.steps.map(s => {
        const act = activities.get(s.name);
        const toolUses = act?.toolUses ?? s.toolUses ?? 0;
        const tokens = act?.lifetimeUsage ? (act.lifetimeUsage.input + act.lifetimeUsage.output + act.lifetimeUsage.cacheWrite) : (s.tokens ? s.tokens.input + s.tokens.output + s.tokens.cacheWrite : 0);
        const tokenStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
        const cost = act?.lifetimeCost ?? s.cost;
        const costStr = cost && cost.total > 0 ? ` · $${cost.total.toFixed(4)}` : '';
        const modelStr = act?.modelId ?? s.modelId ? ` · ${(act?.modelId ?? s.modelId)?.split('.').pop()}` : '';
        const statusIcon = s.status === "running" ? "●" : s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "○";
        return `${statusIcon} ${s.name}${s.phase ? ` (${s.phase})` : ""} · ${toolUses} tools · ${tokenStr} tok${costStr}${modelStr} [${s.status}]`;
      });

      const selected = await ctx.ui.select("Select step to view conversation", stepOptions);
      if (!selected) return;

      const idx = stepOptions.indexOf(selected);
      if (idx < 0) return;
      const step = currentRun.steps[idx]!;
      const activity = activities.get(step.name);

      if (!activity?.session) {
        ctx.ui.notify(`No session available for step "${step.name}".`, "info");
        return;
      }

      try {
        const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import("./ui/viewer.js");
        await ctx.ui.custom(
          (tui: any, theme: any, _keybindings: any, done: any) => {
            return new ConversationViewer(tui, activity!.session!, step, activity, theme, done);
          },
          {
            overlay: true,
            overlayOptions: { anchor: "center" as const, width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
          },
        );
      } catch {
        ctx.ui.notify("Failed to open conversation viewer.", "error");
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

        const mod = await loadWorkflow(ctx.cwd, workflowName);
        const argsHint = mod ? extractArgsHint(mod.body) : undefined;
        const placeholder = argsHint ?? "e.g. JSON or free-form text";

        const workflowArgs = await ctx.ui.input(
          `Args for ${workflowName} (leave empty to skip)`,
          placeholder,
        );

        pi.sendUserMessage(
          `Use the workflow tool with action: "start", workflow: "${workflowName}"${workflowArgs ? `, args: "${workflowArgs}"` : ""} to execute it now.`,
        );
        return;
      }

      const parts = args.split(/\s+/);
      const workflowName = parts[0];
      const workflowArgs = parts.slice(1).join(" ");

      pi.sendUserMessage(
        `Use the workflow tool with action: "start", workflow: "${workflowName}"${workflowArgs ? `, args: "${workflowArgs}"` : ""} to execute it now.`,
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
    const toolInfo = s.toolUses ? ` · ${s.toolUses} tool uses` : "";
    const tokenInfo = s.tokens ? ` · ${formatTokensShort(s.tokens)}` : "";
    const costInfo = s.cost && s.cost.total > 0 ? ` · $${s.cost.total.toFixed(4)}` : "";
    const modelInfo = s.modelId ? ` · ${s.modelId}` : "";
    lines.push(`  ${i + 1}. [${s.status}]${s.phase ? ` (${s.phase})` : ""} ${s.name}${duration}${toolInfo}${tokenInfo}${costInfo}${modelInfo}`);
  }
  if (run.result) {
    lines.push("", "Result:", JSON.stringify(run.result, null, 2));
  }
  return lines.join("\n");
}

function formatTokensShort(tokens: { input: number; output: number; cacheWrite: number }): string {
  const total = tokens.input + tokens.output + tokens.cacheWrite;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tok`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tok`;
  return `${total} tok`;
}
