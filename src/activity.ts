import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { addUsage } from "./ui/format.js";

export interface WorkflowActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  turnCount: number;
  maxTurns?: number;
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
  compactionCount: number;
  session?: AgentSession;
}

export function createActivityTracker(
  maxTurns?: number,
  onStreamUpdate?: () => void,
): { state: WorkflowActivity; callbacks: Record<string, (...args: any[]) => void> } {
  const state: WorkflowActivity = {
    activeTools: new Map(),
    toolUses: 0,
    responseText: "",
    turnCount: 1,
    maxTurns,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };

  const callbacks = {
    onToolActivity(activity: { type: "start" | "end"; toolName: string }) {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta(_delta: string, fullText: string) {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd(turnCount: number) {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated(session: AgentSession) {
      state.session = session;
    },
    onAssistantUsage(usage: { input: number; output: number; cacheWrite: number }) {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}
