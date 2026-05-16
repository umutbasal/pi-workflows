# pi-workflows

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that adds workflow orchestration — define multi-step agent pipelines as simple JavaScript scripts and run them from the TUI.

## Features

- **Discover** workflows from `.pi/workflows/`, `.agents/workflows/`, `.pi-workflows/` in the project tree and `~/.pi/agent/workflows/` globally
- **Execute** workflows with the `workflow` tool or `/workflow` command
- **Pipeline** processing with concurrent items and sequential stages
- **Agent spawning** with optional JSON schema for structured output
- **Run tracking** with persistent status, steps, and results

## Setup

```bash
git clone https://github.com/umutbasal/pi-workflows.git
cd pi-workflows
bun install
pi extensions add ./src/index.ts
```

## Writing Workflows

Create a `.js` or `.ts` file in `.pi/workflows/`:

```js
// .pi/workflows/my-workflow.js
export const meta = {
  name: "my-workflow",
  description: "Does something useful",
  phases: [
    { title: "Discover", detail: "find files" },
    { title: "Process", detail: "process each file" },
  ],
};

export default async function ({ agent, pipeline, log, args }) {
  log("Starting...");

  // Spawn an agent with full tool access
  const files = await agent("Find all TypeScript files in src/", {
    label: "find-files",
    phase: "Discover",
    schema: { type: "array", items: { type: "string" } },
  });

  // Process items through stages (concurrent within each stage)
  const results = await pipeline(
    files,
    (file) => agent(`Analyze ${file}`, { label: `analyze:${file}`, phase: "Process" }),
  );

  return { files, results };
}
```

## Runtime API

Workflows receive a runtime object with:

| Function | Description |
|----------|-------------|
| `agent(prompt, opts?)` | Spawn a sub-agent with full tool access (read/write/bash/grep). Returns text or parsed JSON if `schema` is provided. |
| `pipeline(items, ...stages)` | Process items through stages. Items within a stage run concurrently; stages run sequentially. |
| `log(message)` | Show a notification in the TUI. |
| `args` | Parsed JSON arguments passed to the workflow. |

### Agent Options

```ts
interface AgentOptions {
  label?: string;              // Display name for step tracking
  phase?: string;              // Phase grouping (matches meta.phases)
  schema?: Record<string, unknown>; // JSON schema for structured output
}
```

## Usage

### From the tool

```
Use the workflow tool to start "my-workflow" with args: {"dir": "./src"}
```

### From the command

```
/workflow my-workflow {"dir": "./src"}
/workflow list
```

### Actions

| Action | Description |
|--------|-------------|
| `start` | Execute a workflow (default) |
| `list` | List available workflows and recent runs |
| `status` | Check a run's status by `run_id` |
| `cancel` | Cancel a running workflow by `run_id` |

## Project Structure

```
src/
├── index.ts          # Extension entry point, tool & command registration
├── loader.ts         # Workflow discovery & module loading
├── runtime.ts        # Agent, pipeline, and log runtime creation
├── store.ts          # Run persistence (JSON files in .pi-workflows/.runs/)
├── types.ts          # TypeScript interfaces
├── runtime.test.ts   # Unit tests for runtime (agent, pipeline, log)
├── store.test.ts     # Unit tests for persistence layer
└── format.test.ts    # Unit tests for run formatting
```

## Testing

```bash
bun test
```

```
 39 pass, 0 fail
 75 expect() calls
 Ran 39 tests across 3 files
```

## Workflow Discovery Order

Workflows are searched in this order (first match wins):

1. `.pi/workflows/` — project-local (traverses up to git root)
2. `.agents/workflows/` — project-local (traverses up to git root)
3. `.pi-workflows/` — project-local (traverses up to git root)
4. `~/.pi/agent/workflows/` — global
5. `~/.agents/workflows/` — global

Project workflows override global ones with the same name.

## License

MIT
