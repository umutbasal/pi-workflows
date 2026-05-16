export const meta = {
  name: "bug-review",
  description:
    "Review each source file in a project for potential bugs, vulnerabilities, and code smells",
  phases: [
    { title: "Discover", detail: "find all source files" },
    { title: "Review", detail: "agent reviews each file for bugs" },
    { title: "Report", detail: "compile prioritized bug report" },
  ],
};

const BUG_ANALYSIS_SCHEMA = {
  type: "object",
  required: ["file", "bugs"],
  properties: {
    file: { type: "string", description: "File path" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "category", "title", "description", "line"],
        properties: {
          severity: {
            enum: ["critical", "high", "medium", "low"],
            description:
              "critical=security vuln/data loss/crash, high=logic error/race condition, medium=edge case/resource leak, low=code smell/minor issue",
          },
          category: {
            enum: [
              "security",
              "logic-error",
              "null-reference",
              "race-condition",
              "resource-leak",
              "error-handling",
              "type-safety",
              "boundary",
              "concurrency",
              "performance",
              "code-smell",
            ],
            description: "Category of the bug",
          },
          title: {
            type: "string",
            description: "Short one-line title of the bug",
          },
          description: {
            type: "string",
            description:
              "Detailed explanation of the bug, why it's a problem, and when it would manifest",
          },
          line: {
            type: "number",
            description: "Approximate line number where the bug is located",
          },
          suggestion: {
            type: "string",
            description: "How to fix the bug",
          },
        },
      },
      description: "List of bugs found in this file",
    },
    overall_quality: {
      enum: ["good", "acceptable", "concerning", "poor"],
      description: "Overall code quality assessment",
    },
    notes: {
      type: "string",
      description: "Any general observations about the file's code quality",
    },
  },
};

export default async function ({ agent, pipeline, step, log, args }) {
  const dir = args?.dir ?? ".";
  const extensions = args?.extensions ?? "ts,js,tsx,jsx,py,go,rs";
  const exclude =
    args?.exclude ?? "node_modules,dist,.next,build,coverage,__pycache__,.git";

  // Phase 1: Discover source files
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
  log(`Found ${files.length} source file(s), reviewing for bugs...`);

  // Phase 2: Review each file for bugs
  const results = await pipeline(
    files,
    (file) =>
      agent(
        `Read the source file at "${file}" and carefully review it for bugs, vulnerabilities, and potential issues.

Look for these categories of bugs:

1. **Security** - injection, XSS, auth bypass, secrets in code, unsafe deserialization, path traversal
2. **Logic errors** - wrong conditions, off-by-one, incorrect operator, swapped arguments, missing return
3. **Null/undefined references** - accessing properties on potentially null/undefined values, missing null checks
4. **Race conditions** - shared mutable state, async operations without proper synchronization, TOCTOU
5. **Resource leaks** - unclosed files/connections/streams, missing cleanup in error paths, event listener leaks
6. **Error handling** - swallowed errors, missing try/catch on async, catch-all without re-throw, incorrect error propagation
7. **Type safety** - implicit any, unsafe casts, wrong types passed, missing type narrowing
8. **Boundary issues** - array out of bounds, integer overflow, empty collection access, string encoding issues
9. **Concurrency** - deadlocks, missing await, promise not handled, parallel mutation
10. **Performance** - O(n²) in hot path, unnecessary re-renders, memory leaks, blocking main thread
11. **Code smells** - duplicated logic prone to divergence, magic numbers, overly complex conditions

Be precise and specific. Only report actual bugs or highly likely issues — not style preferences or theoretical concerns.
For each bug, identify the exact line number and provide a concrete fix suggestion.
If the file has no bugs, return an empty bugs array.`,
        {
          label: `review:${file}`,
          phase: "Review",
          schema: BUG_ANALYSIS_SCHEMA,
        },
      ),
  );

  // Phase 3: Compile report
  return await step("compile-report", "Report", async () => {
    const analyzed = files.map((file, i) => {
      const result = results[i];
      if (!result || typeof result !== "object") {
        return { file, bugs: [], overall_quality: "acceptable", notes: "analysis failed" };
      }
      return { file, ...result };
    });

    // Collect all bugs with file context
    const allBugs = [];
    for (const entry of analyzed) {
      if (entry.bugs && entry.bugs.length > 0) {
        for (const bug of entry.bugs) {
          allBugs.push({ ...bug, file: entry.file });
        }
      }
    }

    // Group by severity
    const severities = ["critical", "high", "medium", "low"];
    const bySeverity = {};
    for (const s of severities) {
      bySeverity[s] = allBugs.filter((b) => b.severity === s);
    }

    // Group by category
    const byCategory = {};
    for (const bug of allBugs) {
      if (!byCategory[bug.category]) byCategory[bug.category] = [];
      byCategory[bug.category].push(bug);
    }

    // Files with issues
    const filesWithBugs = analyzed.filter((f) => f.bugs && f.bugs.length > 0);
    const cleanFiles = analyzed.filter((f) => !f.bugs || f.bugs.length === 0);

    const summary = {
      total_files_reviewed: files.length,
      files_with_bugs: filesWithBugs.length,
      clean_files: cleanFiles.length,
      total_bugs_found: allBugs.length,
      by_severity: {
        critical: bySeverity.critical?.length ?? 0,
        high: bySeverity.high?.length ?? 0,
        medium: bySeverity.medium?.length ?? 0,
        low: bySeverity.low?.length ?? 0,
      },
      by_category: Object.fromEntries(
        Object.entries(byCategory)
          .map(([k, v]) => [k, v.length])
          .sort((a, b) => b[1] - a[1]),
      ),
    };

    log(
      `Review complete: ${allBugs.length} bug(s) found across ${filesWithBugs.length} file(s) — ${summary.by_severity.critical} critical, ${summary.by_severity.high} high, ${summary.by_severity.medium} medium, ${summary.by_severity.low} low`,
    );

    return {
      summary,
      critical: bySeverity.critical ?? [],
      high: bySeverity.high ?? [],
      medium: bySeverity.medium ?? [],
      low: bySeverity.low ?? [],
      files: analyzed,
    };
  });
}
