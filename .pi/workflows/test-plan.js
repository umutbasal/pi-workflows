export const meta = {
  name: "test-plan",
  description:
    "Review every source file in a project and recommend what tests are needed (unit, integration) with priority levels",
  phases: [
    { title: "Discover", detail: "find all source files" },
    { title: "Analyze", detail: "agent reviews each file for test needs" },
    { title: "Report", detail: "compile prioritized test plan" },
  ],
};

const FILE_ANALYSIS_SCHEMA = {
  type: "object",
  required: ["file", "needs_unit", "needs_integration", "priority", "reason", "suggestions"],
  properties: {
    file: { type: "string", description: "File path" },
    needs_unit: {
      type: "boolean",
      description: "Whether this file needs unit tests",
    },
    needs_integration: {
      type: "boolean",
      description: "Whether this file needs integration tests",
    },
    has_existing_tests: {
      type: "boolean",
      description: "Whether tests already exist for this file",
    },
    priority: {
      enum: ["critical", "high", "medium", "low", "skip"],
      description:
        "Priority for writing tests. critical=core logic/high risk, high=important business logic, medium=utility/helper, low=simple/low risk, skip=no tests needed",
    },
    reason: {
      type: "string",
      description: "One-line explanation of why this priority and test type",
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          test_type: { enum: ["unit", "integration"] },
          description: {
            type: "string",
            description: "What specific test to write",
          },
          complexity: {
            enum: ["simple", "moderate", "complex"],
            description: "How complex this test would be to write",
          },
        },
        required: ["test_type", "description", "complexity"],
      },
      description: "Specific test suggestions for this file",
    },
    risk_factors: {
      type: "array",
      items: { type: "string" },
      description: "What could go wrong without tests (bugs, regressions, etc.)",
    },
  },
};

export default async function ({ agent, pipeline, step, log, args }) {
  const dir = args?.dir ?? ".";
  const extensions = args?.extensions ?? "ts,js,tsx,jsx,py,go,rs";
  const exclude = args?.exclude ?? "node_modules,dist,.next,build,coverage,__pycache__,.git";

  // Phase 1: Discover source files (excluding test files and generated code)
  log("Discovering source files...");
  const discovery = await agent(
    `Find all source files in "${dir}" with extensions: ${extensions}.
Exclude these directories: ${exclude}
Also exclude test files (*.test.*, *.spec.*, __tests__/, test/, tests/).
Also exclude config files (*.config.*, .eslintrc, tsconfig, etc.), type declaration files (*.d.ts), and lock files.

Use bash with find or fd. Return a JSON array of file paths relative to the project root.
Only include files that contain actual application/library logic.`,
    {
      label: "discover-sources",
      phase: "Discover",
      schema: { type: "array", items: { type: "string" } },
    },
  );

  const files = Array.isArray(discovery) ? discovery : [];
  if (files.length === 0) return { error: "No source files found" };
  log(`Found ${files.length} source file(s), analyzing test needs...`);

  // Phase 2: Analyze each file for test requirements
  const results = await pipeline(
    files,
    (file) =>
      agent(
        `Read the source file at "${file}" and analyze what tests it needs.

Consider:
1. **Unit tests** - needed when the file has:
   - Pure functions with logic/transformations
   - Class methods with branching logic
   - Data validation/parsing
   - Error handling paths
   - Edge cases in algorithms
   - State management logic

2. **Integration tests** - needed when the file has:
   - API endpoint handlers
   - Database queries/mutations
   - External service calls
   - Multi-component interactions
   - Event/message handling across boundaries
   - File system operations
   - Authentication/authorization flows

3. **Priority** based on:
   - **critical**: Core business logic, payment/auth flows, data integrity
   - **high**: Important features, complex algorithms, error-prone code
   - **medium**: Utility functions, helpers with moderate complexity
   - **low**: Simple wrappers, straightforward CRUD, low-risk code
   - **skip**: Config files, re-exports, type-only files, trivial code

Also check if tests already exist for this file (look for corresponding .test. or .spec. files).

Provide specific, actionable test suggestions - not generic ones. Each suggestion should describe a concrete test scenario.`,
        {
          label: `analyze:${file}`,
          phase: "Analyze",
          schema: FILE_ANALYSIS_SCHEMA,
        },
      ),
  );

  // Phase 3: Compile prioritized report
  return await step("compile-report", "Report", async () => {
    const analyzed = files.map((file, i) => {
      const result = results[i];
      if (!result || typeof result !== "object") {
        return { file, priority: "medium", needs_unit: false, needs_integration: false, reason: "analysis failed", suggestions: [] };
      }
      return { file, ...result };
    });

    // Group by priority
    const priorities = ["critical", "high", "medium", "low", "skip"];
    const grouped = {};
    for (const p of priorities) {
      grouped[p] = analyzed.filter((r) => r.priority === p);
    }

    // Stats
    const needsUnit = analyzed.filter((r) => r.needs_unit);
    const needsIntegration = analyzed.filter((r) => r.needs_integration);
    const hasExisting = analyzed.filter((r) => r.has_existing_tests);
    const actionable = analyzed.filter((r) => r.priority !== "skip");

    const summary = {
      total_files: files.length,
      needs_unit_tests: needsUnit.length,
      needs_integration_tests: needsIntegration.length,
      already_has_tests: hasExisting.length,
      by_priority: {
        critical: grouped.critical?.length ?? 0,
        high: grouped.high?.length ?? 0,
        medium: grouped.medium?.length ?? 0,
        low: grouped.low?.length ?? 0,
        skip: grouped.skip?.length ?? 0,
      },
      total_test_suggestions: analyzed.reduce(
        (sum, r) => sum + (r.suggestions?.length ?? 0),
        0,
      ),
    };

    log(
      `Analysis complete: ${actionable.length} files need tests (${summary.by_priority.critical} critical, ${summary.by_priority.high} high, ${summary.by_priority.medium} medium, ${summary.by_priority.low} low)`,
    );

    return {
      summary,
      critical: grouped.critical ?? [],
      high: grouped.high ?? [],
      medium: grouped.medium ?? [],
      low: grouped.low ?? [],
      skipped: grouped.skip ?? [],
    };
  });
}
