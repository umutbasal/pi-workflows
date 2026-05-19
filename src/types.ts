export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail?: string }>;
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
}

export type AgentFn = (prompt: string, options?: AgentOptions) => Promise<any>;
export type LogFn = (message: string) => void;
export type PhaseFn = (name: string) => void;
export type ParallelFn = <T>(thunks: (() => Promise<T>)[]) => Promise<T[]>;

export type PipelineStageFn<TIn, TOut> = (
  input: TIn,
  item: any,
  index: number,
) => TOut | Promise<TOut>;

export type PipelineFn = <T>(
  items: T[],
  ...stages: PipelineStageFn<any, any>[]
) => Promise<any[]>;

export interface WorkflowRuntime {
  agent: AgentFn;
  log: LogFn;
  phase: PhaseFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
}

export interface WorkflowModule {
  meta: WorkflowMeta;
  body: string;
}

export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowStep {
  name: string;
  phase?: string;
  status: WorkflowStepStatus;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  toolUses?: number;
  turnCount?: number;
  tokens?: { input: number; output: number; cacheWrite: number };
  compactionCount?: number;
  activity?: string;
  modelName?: string;
  modelId?: string;
  provider?: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  sessionId?: string;
}

export interface WorkflowRun {
  runId: string;
  workflow: string;
  status: "running" | "completed" | "failed" | "cancelled";
  args?: Record<string, unknown> | string;
  createdAt: number;
  updatedAt: number;
  steps: WorkflowStep[];
  result?: unknown;
}
