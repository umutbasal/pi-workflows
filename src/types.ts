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

export interface PipelineContext {
  agent: AgentFn;
  log: LogFn;
  args: Record<string, unknown> | undefined;
}

export type PipelineStageFn<TIn, TOut> = (
  input: TIn,
  item: any,
  index: number,
) => TOut | Promise<TOut>;

export type PipelineFn = <T>(
  items: T[],
  ...stages: PipelineStageFn<any, any>[]
) => Promise<any[]>;

export interface WorkflowRuntime extends PipelineContext {
  pipeline: PipelineFn;
}

export interface WorkflowModule {
  meta: WorkflowMeta;
  default?: (runtime: WorkflowRuntime) => Promise<any>;
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
}

export interface WorkflowRun {
  runId: string;
  workflow: string;
  status: "running" | "completed" | "failed" | "cancelled";
  args?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  steps: WorkflowStep[];
  result?: unknown;
}
