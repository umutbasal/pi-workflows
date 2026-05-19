import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export { truncateToWidth, visibleWidth, wrapTextWithAnsi };

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped", "failed", "cancelled"]);

export const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `↻${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `⟳${turnCount}≤${maxTurns}` : `⟳${turnCount}`;
}

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

export function getLifetimeTotal(u?: { input: number; output: number; cacheWrite: number }): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

export function addUsage(into: { input: number; output: number; cacheWrite: number }, delta: { input: number; output: number; cacheWrite: number }): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
}

export type SessionLike = { getSessionStats(): { tokens: { input: number; output: number; cacheWrite: number }; contextUsage?: { percent: number | null } } };

export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}

export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `${(usd * 100).toFixed(2)}¢`;
}
