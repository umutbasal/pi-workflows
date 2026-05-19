import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface SessionToolUse {
  name: string;
  count: number;
  arguments?: Record<string, unknown>;
  lastUsed?: string;
}

export interface SessionModelUse {
  model: string;
  provider: string;
  messageCount: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface SessionMessage {
  id: string;
  parentId: string | null;
  timestamp: string;
  role: string;
  content: string;
  model?: string;
  provider?: string;
  stopReason?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

export interface SessionStats {
  id: string;
  cwd: string;
  createdAt: string;
  totalMessages: number;
  assistantMessages: number;
  userMessages: number;
  toolMessages: number;
  models: SessionModelUse[];
  tools: SessionToolUse[];
  totalTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  totalCost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  messages: SessionMessage[];
  stopReasons: Record<string, number>;
}

interface JsonlEvent {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  modelId?: string;
  provider?: string;
  message?: {
    role: string;
    content: unknown;
    model?: string;
    provider?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_write_input_tokens?: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
    };
    stopReason?: string;
    errorMessage?: string;
  };
}

function safeJsonlParse(line: string): JsonlEvent | null {
  try {
    return JSON.parse(line) as JsonlEvent;
  } catch {
    return null;
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n");
  }
  return "";
}

function extractToolCalls(content: unknown): Array<{ name: string; arguments?: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b.type === "toolCall" || b.type === "tool_use")
    .map((b: any) => ({
      name: b.name ?? "unknown",
      arguments: b.arguments ?? b.input,
    }));
}

function normalizeUsage(usage: any): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const input = usage.input_tokens ?? usage.input ?? 0;
  const output = usage.output_tokens ?? usage.output ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? usage.cacheRead ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? usage.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: usage.totalTokens ?? (input + output + cacheRead + cacheWrite),
  };
}

function normalizeCost(usage: any): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  const c = usage?.cost;
  if (!c) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input: c.input ?? 0,
    output: c.output ?? 0,
    cacheRead: c.cacheRead ?? 0,
    cacheWrite: c.cacheWrite ?? 0,
    total: c.total ?? 0,
  };
}

export async function parseSessionFile(filePath: string): Promise<SessionStats | null> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());

  let sessionId = "";
  let sessionCwd = "";
  let sessionCreatedAt = "";
  const messages: SessionMessage[] = [];
  const modelMap = new Map<string, SessionModelUse>();
  const toolMap = new Map<string, SessionToolUse>();
  const stopReasons: Record<string, number> = {};
  const totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const totalCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  let currentModel = "";
  let currentProvider = "";

  for (const line of lines) {
    const event = safeJsonlParse(line);
    if (!event) continue;

    if (event.type === "session") {
      sessionId = event.id ?? "";
      sessionCwd = event.cwd ?? "";
      sessionCreatedAt = event.timestamp ?? "";
    } else if (event.type === "model_change") {
      currentModel = event.modelId ?? "";
      currentProvider = event.provider ?? "";
    } else if (event.type === "message" && event.message) {
      const msg = event.message;
      const usage = normalizeUsage(msg.usage);
      const cost = normalizeCost(msg.usage);
      const toolCalls = extractToolCalls(msg.content);
      const textContent = extractTextContent(msg.content);

      const modelKey = msg.model ?? currentModel ?? "unknown";
      const providerKey = msg.provider ?? currentProvider ?? "unknown";

      if (msg.role === "assistant") {
        if (usage.total > 0 || cost.total > 0) {
          const modelUseKey = `${modelKey}|${providerKey}`;
          const existing = modelMap.get(modelUseKey);
          if (existing) {
            existing.messageCount++;
            existing.tokens.input += usage.input;
            existing.tokens.output += usage.output;
            existing.tokens.cacheRead += usage.cacheRead;
            existing.tokens.cacheWrite += usage.cacheWrite;
            existing.tokens.total += usage.total;
            existing.cost.input += cost.input;
            existing.cost.output += cost.output;
            existing.cost.cacheRead += cost.cacheRead;
            existing.cost.cacheWrite += cost.cacheWrite;
            existing.cost.total += cost.total;
          } else {
            modelMap.set(modelUseKey, {
              model: modelKey,
              provider: providerKey,
              messageCount: 1,
              tokens: { ...usage },
              cost: { ...cost },
            });
          }

          totalTokens.input += usage.input;
          totalTokens.output += usage.output;
          totalTokens.cacheRead += usage.cacheRead;
          totalTokens.cacheWrite += usage.cacheWrite;
          totalTokens.total += usage.total;
          totalCost.input += cost.input;
          totalCost.output += cost.output;
          totalCost.cacheRead += cost.cacheRead;
          totalCost.cacheWrite += cost.cacheWrite;
          totalCost.total += cost.total;
        }

        if (msg.stopReason) {
          stopReasons[msg.stopReason] = (stopReasons[msg.stopReason] ?? 0) + 1;
        }

        for (const tc of toolCalls) {
          const existing = toolMap.get(tc.name);
          if (existing) {
            existing.count++;
            existing.lastUsed = event.timestamp ?? existing.lastUsed;
            if (tc.arguments) existing.arguments = tc.arguments;
          } else {
            toolMap.set(tc.name, {
              name: tc.name,
              count: 1,
              arguments: tc.arguments,
              lastUsed: event.timestamp,
            });
          }
        }
      }

      const messageSummary: SessionMessage = {
        id: event.id ?? "",
        parentId: event.parentId ?? null,
        timestamp: event.timestamp ?? "",
        role: msg.role,
        content: textContent.slice(0, 500),
        model: msg.model ?? currentModel,
        provider: msg.provider ?? currentProvider,
        stopReason: msg.stopReason,
        tokens: usage.total > 0 ? { ...usage } : undefined,
        cost: cost.total > 0 ? { ...cost } : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      if (textContent || toolCalls.length > 0 || msg.stopReason) {
        messages.push(messageSummary);
      }
    }
  }

  return {
    id: sessionId,
    cwd: sessionCwd,
    createdAt: sessionCreatedAt,
    totalMessages: messages.length,
    assistantMessages: messages.filter(m => m.role === "assistant").length,
    userMessages: messages.filter(m => m.role === "user").length,
    toolMessages: messages.filter(m => m.role === "tool").length,
    models: Array.from(modelMap.values()).sort((a, b) => b.tokens.total - a.tokens.total),
    tools: Array.from(toolMap.values()).sort((a, b) => b.count - a.count),
    totalTokens,
    totalCost,
    messages,
    stopReasons,
  };
}

function projectPathToSessionDir(cwd: string): string {
  return cwd.replace(/\//g, "-").replace(/^--/, "");
}

export async function findSessionById(sessionId: string): Promise<string | null> {
  const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
  try {
    const projectDirs = await readdir(sessionsDir);
    for (const projectDir of projectDirs) {
      const projectPath = join(sessionsDir, projectDir);
      const projectStat = await stat(projectPath);
      if (!projectStat.isDirectory()) continue;

      const files = await readdir(projectPath);
      for (const file of files) {
        if (file.includes(sessionId)) {
          return join(projectPath, file);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function listSessionsForProject(cwd: string): Promise<string[]> {
  const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
  const projectDirName = `--${cwd.replace(/\//g, "-")}--`;
  const projectPath = join(sessionsDir, projectDirName);

  try {
    const files = await readdir(projectPath);
    return files
      .filter(f => f.endsWith(".jsonl"))
      .map(f => join(projectPath, f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function getSessionStatsForRun(steps: Array<{ sessionId?: string }>): Promise<SessionStats | null> {
  const sessionIds = steps
    .map(s => s.sessionId)
    .filter((id): id is string => !!id);

  if (sessionIds.length === 0) return null;

  const allStats: SessionStats[] = [];
  for (const sessionId of sessionIds) {
    const filePath = await findSessionById(sessionId);
    if (filePath) {
      const stats = await parseSessionFile(filePath);
      if (stats) allStats.push(stats);
    }
  }

  if (allStats.length === 0) return null;
  if (allStats.length === 1) return allStats[0];

  return mergeSessionStats(allStats);
}

function mergeSessionStats(statsList: SessionStats[]): SessionStats {
  const merged: SessionStats = {
    id: statsList.map(s => s.id).join(", "),
    cwd: statsList[0]?.cwd ?? "",
    createdAt: statsList[0]?.createdAt ?? "",
    totalMessages: 0,
    assistantMessages: 0,
    userMessages: 0,
    toolMessages: 0,
    models: [],
    tools: [],
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    totalCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    messages: [],
    stopReasons: {},
  };

  for (const stats of statsList) {
    merged.totalMessages += stats.totalMessages;
    merged.assistantMessages += stats.assistantMessages;
    merged.userMessages += stats.userMessages;
    merged.toolMessages += stats.toolMessages;
    merged.messages.push(...stats.messages);

    merged.totalTokens.input += stats.totalTokens.input;
    merged.totalTokens.output += stats.totalTokens.output;
    merged.totalTokens.cacheRead += stats.totalTokens.cacheRead;
    merged.totalTokens.cacheWrite += stats.totalTokens.cacheWrite;
    merged.totalTokens.total += stats.totalTokens.total;

    merged.totalCost.input += stats.totalCost.input;
    merged.totalCost.output += stats.totalCost.output;
    merged.totalCost.cacheRead += stats.totalCost.cacheRead;
    merged.totalCost.cacheWrite += stats.totalCost.cacheWrite;
    merged.totalCost.total += stats.totalCost.total;

    for (const model of stats.models) {
      const key = `${model.model}|${model.provider}`;
      const existing = merged.models.find(m => `${m.model}|${m.provider}` === key);
      if (existing) {
        existing.messageCount += model.messageCount;
        existing.tokens.input += model.tokens.input;
        existing.tokens.output += model.tokens.output;
        existing.tokens.cacheRead += model.tokens.cacheRead;
        existing.tokens.cacheWrite += model.tokens.cacheWrite;
        existing.tokens.total += model.tokens.total;
        existing.cost.input += model.cost.input;
        existing.cost.output += model.cost.output;
        existing.cost.cacheRead += model.cost.cacheRead;
        existing.cost.cacheWrite += model.cost.cacheWrite;
        existing.cost.total += model.cost.total;
      } else {
        merged.models.push({ ...model });
      }
    }

    for (const tool of stats.tools) {
      const existing = merged.tools.find(t => t.name === tool.name);
      if (existing) {
        existing.count += tool.count;
        existing.lastUsed = tool.lastUsed ?? existing.lastUsed;
      } else {
        merged.tools.push({ ...tool });
      }
    }

    for (const [reason, count] of Object.entries(stats.stopReasons)) {
      merged.stopReasons[reason] = (merged.stopReasons[reason] ?? 0) + count;
    }
  }

  merged.models.sort((a, b) => b.tokens.total - a.tokens.total);
  merged.tools.sort((a, b) => b.count - a.count);

  return merged;
}
