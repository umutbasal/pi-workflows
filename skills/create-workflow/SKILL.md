---
name: create-workflow
description: Create a pi workflow script that orchestrates multi-step agent pipelines. Use when asked to "create a workflow", "make a workflow for X", "build a pipeline that...", or "automate X with agents".
---

# Create Workflow

Create workflow scripts that orchestrate sub-agents in pipelines. Workflows are the way to fan-out work across multiple agents concurrently.

## Key Principle

**Delegate ALL I/O and intelligence to `agent()`.** The workflow script is pure orchestration — control flow, data plumbing, and aggregation only.

- **DON'T** manually use `fs`, `fetch`, `child_process`, `glob`, `readline`, etc.
- **DO** ask the agent in natural language to: find files, read content, search the web, call APIs, install packages, run shell commands, parse data, write files, etc.

The agent has full tool access (read, write, bash, grep, find, fetch URLs, etc.) — leverage it for everything.

## Runtime API

```js
export default async function ({ agent, pipeline, step, log, args }) { ... }
```

### `agent(prompt, opts?)` — Spawn a sub-agent

The core primitive. Each agent call spawns an independent agent that can use all tools.

```js
// Plain text response
const explanation = await agent(`Read "src/index.ts" and explain what it does.`);

// Structured JSON response (via schema)
const files = await agent(`Find all .ts source files, excluding node_modules and tests.`, {
  label: "find-files",       // display label for tracking
  phase: "Discover",         // groups step under a phase in the UI
  schema: {                  // JSON Schema → agent returns parsed JSON
    type: "array",
    items: { type: "string" }
  },
});
```

**Agent capabilities** (just ask in the prompt):
- Read/write/edit files
- Run bash commands (find, grep, sed, awk, curl, etc.)
- List directories, search codebases
- Fetch URLs, read web pages
- Install packages, run builds
- Parse any format (JSON, YAML, CSV, logs, etc.)
- Analyze code, find patterns, refactor

### `pipeline(items, ...stages)` — Concurrent item processing

Process an array of items through one or more stages. Items within a stage run **concurrently**. Stages run **sequentially** (each receives the previous stage's output).

```js
// Single stage: review each file concurrently
const results = await pipeline(files, (file) =>
  agent(`Read "${file}" and analyze it for security issues.`, {
    label: `review:${file}`,
    phase: "Analyze",
    schema: { type: "object", properties: { file: {type:"string"}, issues: {type:"array"} } },
  })
);

// Multi-stage: analyze then fix
const results = await pipeline(
  files,
  // Stage 1: analyze (all files concurrently)
  (file) => agent(`Read "${file}" and find code smells`, {
    schema: { type: "object", properties: { file:{type:"string"}, smells:{type:"array",items:{type:"string"}} } },
  }),
  // Stage 2: fix using stage 1's result (all files concurrently)
  (analysis, file, index) => agent(
    `Fix these code smells in "${file}": ${JSON.stringify(analysis.smells)}. Edit the file directly.`
  )
);
```

**Stage function signatures:**
- First stage: `(item) => ...`
- Subsequent stages: `(prevResult, item, index) => ...`

### `step(name, phase, fn)` — Tracked computation

For pure JavaScript logic (aggregation, filtering, formatting) that doesn't need an agent. Tracked with timing in the run log.

```js
return await step("compile-report", "Report", async () => {
  const withIssues = results.filter(r => r?.issues?.length > 0);
  log(`Found ${withIssues.length} files with issues`);
  return { summary: { total: files.length, withIssues: withIssues.length }, details: withIssues };
});
```

### `log(message)` — Progress notification

Show a status message to the user during execution.

```js
log("Analyzing 42 files...");
log(`Phase complete: ${results.length} items processed`);
```

### `args` — Workflow arguments

Parsed JSON from the tool call's `args` parameter. Always use defaults.

```js
const dir = args?.dir || ".";
const extensions = args?.extensions ?? "ts,js";
const depth = args?.maxDepth ?? 3;
```

## Workflow Structure

```js
// Required: meta export with name and description
export const meta = {
  name: "my-workflow",
  description: "What this workflow does",
  // Optional: phases for UI grouping
  phases: [
    { title: "Discover", detail: "find targets" },
    { title: "Process", detail: "analyze each target" },
    { title: "Report", detail: "compile results" },
  ],
};

// Required: default export async function
export default async function ({ agent, pipeline, step, log, args }) {
  // 1. Discovery — agent finds what to work on
  // 2. Processing — pipeline fans out work concurrently
  // 3. Reporting — step aggregates results
  return finalResult;
}
```

## File Location

Write workflow files to: `.pi/workflows/<name>.js`

## Patterns

### Discovery → Fan-out → Aggregate

The most common pattern. Agent discovers items, pipeline processes them concurrently, step compiles results.

```js
export const meta = {
  name: "audit",
  description: "Security audit all endpoints",
  phases: [
    { title: "Discover", detail: "find API endpoints" },
    { title: "Audit", detail: "check each endpoint" },
    { title: "Report", detail: "compile findings" },
  ],
};

export default async function ({ agent, pipeline, step, log, args }) {
  log("Finding API endpoints...");
  const endpoints = await agent(
    `Find all API route handlers in this project. Look for Express routes, Next.js API routes, or similar.`,
    { label: "find-endpoints", phase: "Discover", schema: { type: "array", items: { type: "string" } } }
  );

  const audits = await pipeline(endpoints, (endpoint) =>
    agent(`Read "${endpoint}" and check for: SQL injection, XSS, auth bypass, rate limiting gaps, input validation issues.`, {
      label: `audit:${endpoint}`,
      phase: "Audit",
      schema: {
        type: "object",
        properties: {
          file: { type: "string" },
          vulnerabilities: { type: "array", items: { type: "object", properties: {
            severity: { enum: ["critical","high","medium","low"] },
            type: { type: "string" },
            description: { type: "string" },
            fix: { type: "string" },
          }}},
        },
      },
    })
  );

  return await step("report", "Report", () => {
    const vulns = audits.flatMap(a => a?.vulnerabilities ?? []);
    log(`Audit complete: ${vulns.length} vulnerabilities found`);
    return { total_endpoints: endpoints.length, total_vulnerabilities: vulns.length, by_severity: { critical: vulns.filter(v=>v.severity==="critical").length, high: vulns.filter(v=>v.severity==="high").length }, details: audits };
  });
}
```

### Simple Single-Agent

When the workflow is just one intelligent task with no fan-out:

```js
export const meta = { name: "summarize", description: "Summarize the project" };

export default async function ({ agent, args }) {
  return await agent(
    `Read the README, package.json, and main source files of this project. Write a comprehensive summary covering: purpose, architecture, dependencies, and how to get started.`
  );
}
```

### Web Research with Synthesis

Agent fetches external information, pipeline processes sources, agent synthesizes:

```js
export const meta = { name: "research", description: "Research a topic" };

export default async function ({ agent, pipeline, step, log, args }) {
  const topic = args?.topic ?? "error";
  const sources = await agent(
    `Find 5 authoritative sources about "${topic}". Search the web, find relevant URLs.`,
    { schema: { type: "array", items: { type: "object", properties: { url:{type:"string"}, title:{type:"string"} } } } }
  );
  const summaries = await pipeline(sources, (src) =>
    agent(`Read ${src.url} and extract the key insights about "${topic}"`, {
      schema: { type: "object", properties: { source:{type:"string"}, insights:{type:"array",items:{type:"string"}} } },
    })
  );
  return await step("synthesize", "Synthesize", () =>
    agent(`Write a comprehensive report on "${topic}" synthesizing these findings:\n${JSON.stringify(summaries, null, 2)}`)
  );
}
```

### Mutating Workflow (agent edits files)

Agents can write/edit files directly — useful for refactoring, migration, etc:

```js
export const meta = { name: "migrate", description: "Migrate deprecated API usage" };

export default async function ({ agent, pipeline, log, args }) {
  const pattern = args?.pattern ?? "oldFunction";
  const files = await agent(
    `Find all source files that use "${pattern}". Use grep/ripgrep to search.`,
    { schema: { type: "array", items: { type: "string" } } }
  );
  log(`Found ${files.length} files to migrate`);
  return await pipeline(files, (file) =>
    agent(`Read "${file}" and replace all uses of "${pattern}" with the new API. Edit the file in place. Explain what you changed.`)
  );
}
```

## Tips

- **Schema design**: Keep schemas minimal — only require what you'll actually use downstream. Complex nested schemas increase the chance of malformed output.
- **Error resilience**: For large pipelines, add `.catch()` in the stage to avoid one failure crashing all results:
  ```js
  pipeline(files, (file) =>
    agent(...).catch(err => ({ file, error: err.message, bugs: [] }))
  )
  ```
- **Labels matter**: Use descriptive labels (`label: \`review:${file}\``) — they show up in the UI for tracking progress.
- **Args defaults**: Always provide sensible defaults for all args so the workflow runs without configuration.
- **Return value**: The workflow's return value is displayed to the user. Return structured data (objects/arrays) for machine-readable output, or a string for human-readable summaries.
