import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkflowActivity } from "../activity";
import type { WorkflowStep, WorkflowRun } from "../types";
import {
  SPINNER,
  ERROR_STATUSES,
  describeActivity,
  formatMs,
  formatSessionTokens,
  formatTurns,
  getLifetimeTotal,
  getSessionContextPercent,
  type Theme,
} from "./format.js";

const MAX_WIDGET_LINES = 14;

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: TUI, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

type StepViewItem = {
  step: WorkflowStep;
  status: "running" | "finished";
  connector: string;
  indent: string;
  header: string;
  activity: string;
};

export class WorkflowWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private finishedTurnAge = new Map<string, number>();
  private static readonly ERROR_LINGER_TURNS = 2;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private lastStatusText: string | undefined;
  private viewItems: StepViewItem[] = [];

  constructor(
    private run: WorkflowRun,
    private activities: Map<string, WorkflowActivity>,
  ) {}

  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  onTurnStart() {
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    this.update();
  }

  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  private shouldShowFinished(stepName: string, status: string): boolean {
    const age = this.finishedTurnAge.get(stepName) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? WorkflowWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  markFinished(stepName: string) {
    if (!this.finishedTurnAge.has(stepName)) {
      this.finishedTurnAge.set(stepName, 0);
    }
  }

  private buildViewItems(steps: WorkflowStep[], running: WorkflowStep[], finished: WorkflowStep[], theme: Theme, truncate: (s: string) => string): StepViewItem[] {
    const items: StepViewItem[] = [];
    const allItems = [...finished, ...running];
    const total = allItems.length;
    let idx = 0;

    for (const s of allItems) {
      idx++;
      const isLast = idx === total;
      const isRunning = s.status === "running";
      const connector = isLast ? "└─" : "├─";
      const indent = isLast ? "   " : "│  ";

      const duration = s.startedAt ? formatMs((s.completedAt ?? Date.now()) - s.startedAt) : "";
      const activity = this.activities.get(s.name);
      const toolUses = activity?.toolUses ?? s.toolUses ?? 0;
      const tokens = getLifetimeTotal(activity?.lifetimeUsage);
      const session = activity?.session;
      const contextPercent = getSessionContextPercent(session);

      let icon: string;
      if (isRunning) {
        icon = theme.fg("accent", SPINNER[this.widgetFrame % SPINNER.length]);
      } else if (s.status === "completed") {
        icon = theme.fg("success", "✓");
      } else if (s.status === "failed") {
        icon = theme.fg("error", "✗");
      } else if (s.status === "cancelled") {
        icon = theme.fg("dim", "■");
      } else {
        icon = theme.fg("dim", "○");
      }

      const parts: string[] = [];
      if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
      else if (s.turnCount != null) parts.push(formatTurns(s.turnCount));
      if (toolUses > 0) parts.push(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
      if (tokens > 0) {
        parts.push(formatSessionTokens(tokens, contextPercent, theme));
      }
      parts.push(duration);

      const statsText = parts.join(" · ");
      const activityText = activity
        ? describeActivity(activity.activeTools, activity.responseText)
        : isRunning
          ? "thinking…"
          : (s.activity || "done");

      const name = theme.bold(s.name);
      const phaseTag = s.phase ? ` ${theme.fg("dim", `(${s.phase})`)}` : "";
      const errorTag = s.error && !isRunning
        ? ` ${theme.fg("error", `error: ${s.error.slice(0, 40)}`)}`
        : "";

      const header = truncate(`${icon} ${name}${phaseTag}  ${theme.fg("dim", statsText)}${errorTag}`);
      const activityLine = truncate(`${indent}⎿  ${activityText}`);

      items.push({
        step: s,
        status: isRunning ? "running" : "finished",
        connector,
        indent,
        header,
        activity: activityLine,
      });
    }

    return items;
  }

  private renderWidget(tui: TUI, theme: Theme): string[] {
    const steps = this.run.steps;
    const running = steps.filter(s => s.status === "running");
    const finished = steps.filter(s =>
      s.status !== "running" && s.status !== "pending" && s.completedAt
      && this.shouldShowFinished(s.name, s.status),
    );

    const hasActive = running.length > 0;
    const hasFinished = finished.length > 0;

    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    this.viewItems = this.buildViewItems(steps, running, finished, theme, truncate);

    const headingIcon = hasActive ? "●" : "○";
    const headingText = `${headingIcon} Workflow: ${this.run.workflow}${hasActive ? ` (${running.length} running)` : ""}`;
    const lines: string[] = [truncate(theme.fg(hasActive ? "accent" : "dim", headingText))];

    const maxBody = MAX_WIDGET_LINES - 1;
    const totalBody = this.viewItems.length;

    if (totalBody <= maxBody) {
      for (let i = 0; i < this.viewItems.length; i++) {
        const item = this.viewItems[i]!;
        const isLast = i === this.viewItems.length - 1;
        const connector = isLast ? "└─" : "├─";
        lines.push(truncate(theme.fg("dim", connector) + " " + item.header));
        lines.push(truncate(theme.fg("dim", item.activity)));
      }
    } else {
      let budget = maxBody - 1;
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      const runningItems = this.viewItems.filter(v => v.status === "running");
      const finishedItems = this.viewItems.filter(v => v.status === "finished");

      for (const item of runningItems) {
        if (budget >= 2) {
          lines.push(truncate(theme.fg("dim", item.connector) + " " + item.header));
          lines.push(truncate(theme.fg("dim", item.activity)));
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      for (const item of finishedItems) {
        if (budget >= 2) {
          lines.push(truncate(theme.fg("dim", item.connector) + " " + item.header));
          lines.push(truncate(theme.fg("dim", item.activity)));
          budget -= 2;
        } else {
          hiddenFinished++;
        }
      }

      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`));
    }

    const hint = truncate(theme.fg("dim", "  /workflow-steps to view conversations"));
    lines.push(hint);

    return lines;
  }

  update() {
    if (!this.uiCtx) return;
    const steps = this.run.steps;

    let runningCount = 0;
    let hasFinished = false;
    for (const s of steps) {
      if (s.status === "running") runningCount++;
      else if (s.completedAt && this.shouldShowFinished(s.name, s.status)) hasFinished = true;
    }
    const hasActive = runningCount > 0;

    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("workflow", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("workflow", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      for (const [id] of this.finishedTurnAge) {
        if (!steps.some(s => s.name === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    let newStatusText: string | undefined;
    if (hasActive) {
      newStatusText = `${runningCount} step${runningCount === 1 ? "" : "s"} running`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("workflow", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("workflow", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("workflow", undefined);
      this.uiCtx.setStatus("workflow", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
