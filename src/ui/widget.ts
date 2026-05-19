import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkflowActivity } from "../activity";
import type { WorkflowStep, WorkflowRun } from "../types";
import {
  SPINNER,
  ERROR_STATUSES,
  describeActivity,
  formatDuration,
  formatMs,
  formatSessionTokens,
  formatTokens,
  formatTurns,
  getLifetimeTotal,
  getSessionContextPercent,
  type Theme,
} from "./format.js";

const MAX_WIDGET_LINES = 12;

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: TUI, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
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

  private renderStepLine(
    step: WorkflowStep,
    status: "running" | "finished",
    theme: Theme,
    spinnerFrame?: number,
    _isLast?: boolean,
  ): [string, string] {
    const duration = step.startedAt
      ? formatMs((step.completedAt ?? Date.now()) - step.startedAt)
      : "";
    const activity = this.activities.get(step.name);
    const toolUses = activity?.toolUses ?? step.toolUses ?? 0;
    const tokens = getLifetimeTotal(activity?.lifetimeUsage);
    const session = activity?.session;
    const contextPercent = getSessionContextPercent(session);

    let icon: string;
    if (status === "running") {
      icon = theme.fg("accent", SPINNER[(spinnerFrame ?? 0) % SPINNER.length]);
    } else if (step.status === "completed") {
      icon = theme.fg("success", "✓");
    } else if (step.status === "failed") {
      icon = theme.fg("error", "✗");
    } else if (step.status === "cancelled") {
      icon = theme.fg("dim", "■");
    } else {
      icon = theme.fg("dim", "○");
    }

    const parts: string[] = [];
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    else if (step.turnCount != null) parts.push(formatTurns(step.turnCount));
    if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
    if (tokens > 0) {
      const tokenText = formatSessionTokens(tokens, contextPercent, theme);
      parts.push(tokenText);
    }
    parts.push(duration);

    const statsText = parts.join(" · ");
    const activityText = activity
      ? describeActivity(activity.activeTools, activity.responseText)
      : status === "finished"
        ? (step.activity || "done")
        : "thinking…";

    const name = theme.bold(step.name);
    const phaseTag = step.phase ? ` ${theme.fg("dim", `(${step.phase})`)}` : "";
    const errorTag = step.error && status === "finished"
      ? ` ${theme.fg("error", `error: ${step.error.slice(0, 40)}`)}`
      : "";

    const header = `${icon} ${name}${phaseTag}  ${theme.fg("dim", statsText)}${errorTag}`;
    const activityLine = `⎿  ${activityText}`;
    return [header, activityLine];
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
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build all body items as { header, activity } pairs
    type BodyItem = { header: string; activity: string; isLast: boolean };
    const bodyItems: BodyItem[] = [];

    const allFinished = [...finished];
    const allRunning = [...running];
    const totalItems = allFinished.length + allRunning.length;
    let idx = 0;

    for (const s of allFinished) {
      idx++;
      const isLast = idx === totalItems;
      const connector = isLast ? "└─" : "├─";
      const stepLines = this.renderStepLine(s, "finished", theme, undefined, isLast);
      const [header, activity] = stepLines;
      bodyItems.push({
        header: truncate(theme.fg("dim", connector) + " " + header),
        activity: truncate(theme.fg("dim", isLast ? "   " : "│  ") + " " + activity),
        isLast,
      });
    }

    for (const s of allRunning) {
      idx++;
      const isLast = idx === totalItems;
      const connector = isLast ? "└─" : "├─";
      const stepLines = this.renderStepLine(s, "running", theme, this.widgetFrame, isLast);
      const [header, activity] = stepLines;
      bodyItems.push({
        header: truncate(theme.fg("dim", connector) + " " + header),
        activity: truncate(theme.fg("dim", isLast ? "   " : "│  ") + " " + activity),
        isLast,
      });
    }

    const maxBody = MAX_WIDGET_LINES - 1;
    const totalBody = bodyItems.length;

    const headingIcon = hasActive ? "●" : "○";
    const headingText = `${headingIcon} Workflow: ${this.run.workflow}${hasActive ? ` (${running.length} running)` : ""}`;
    const lines: string[] = [truncate(theme.fg(hasActive ? "accent" : "dim", headingText))];

    if (totalBody <= maxBody) {
      for (const item of bodyItems) {
        lines.push(item.header);
        lines.push(item.activity);
      }
    } else {
      let budget = maxBody - 1;
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      // Running agents first (2 lines each)
      const runningItems = bodyItems.filter((_, i) => i >= allFinished.length);
      const finishedItems = bodyItems.filter((_, i) => i < allFinished.length);

      for (const item of runningItems) {
        if (budget >= 2) {
          lines.push(item.header);
          lines.push(item.activity);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      for (const item of finishedItems) {
        if (budget >= 2) {
          lines.push(item.header);
          lines.push(item.activity);
          budget--;
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
