export const meta = {
  name: "test-analysis",
  description: "Analyze source files to determine what tests are needed (unit or integration) and group by severity",
  phases: [
    { title: "Discover", detail: "find source files" },
    { title: "Analyze", detail: "determine test needs per file" },
    { title: "Report", detail: "group by severity and summarize" },
  ],
};

const dir = args?.dir || "src";
const extensions = args?.extensions ?? "ts,js,tsx,jsx";

phase("Discover");
log("Finding source files...");
const files = await agent(
  `Find all source files with extensions ${extensions} in the "${dir}" directory. Exclude node_modules, dist, build, coverage, and existing test files (*.test.*, *.spec.*, __tests__). Return only file paths.`,
  {
    label: "find-sources",
    schema: { type: "array", items: { type: "string" } },
  }
);

log(`Found ${files.length} source files to analyze`);

phase("Analyze");
const analyses = await pipeline(files, (file) =>
  agent(
    `Read "${file}" and analyze what tests are needed. For each testable feature/function/behavior in the file, determine:
1. What should be tested
2. Whether it needs a UNIT test (isolated logic, pure functions, single component) or INTEGRATION test (multiple components, external services, database, API calls, file system)
3. Severity/priority: "critical" (core business logic, data mutations, auth, payments), "high" (important features, error handling, edge cases), "medium" (utilities, helpers, standard CRUD), "low" (formatting, cosmetic, rarely-changing code)

Consider:
- Functions with side effects or external dependencies → integration
- Pure logic, transformations, validators → unit
- Code handling money, auth, or user data → critical
- Error boundaries and edge cases → high
- Standard getters/setters, simple utils → low`,
    {
      label: `analyze:${file}`,
      schema: {
        type: "object",
        properties: {
          file: { type: "string" },
          features: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                testType: { enum: ["unit", "integration"] },
                severity: { enum: ["critical", "high", "medium", "low"] },
                reason: { type: "string" },
              },
            },
          },
        },
      },
    }
  ).catch(err => ({ file, features: [], error: err.message }))
);

phase("Report");
const allFeatures = analyses.flatMap(a => 
  (a?.features ?? []).map(f => ({ ...f, file: a.file }))
);

const bySeverity = {
  critical: allFeatures.filter(f => f.severity === "critical"),
  high: allFeatures.filter(f => f.severity === "high"),
  medium: allFeatures.filter(f => f.severity === "medium"),
  low: allFeatures.filter(f => f.severity === "low"),
};

const byType = {
  unit: allFeatures.filter(f => f.testType === "unit"),
  integration: allFeatures.filter(f => f.testType === "integration"),
};

log(`Analysis complete: ${allFeatures.length} testable features identified`);

await agent(
  `Write a markdown report to "test-analysis-report.md" with this data:

# Test Analysis Report

## Summary
- Total files analyzed: ${files.length}
- Total testable features: ${allFeatures.length}
- Unit tests needed: ${byType.unit.length}
- Integration tests needed: ${byType.integration.length}

## By Severity

### 🔴 Critical (${bySeverity.critical.length})
${JSON.stringify(bySeverity.critical, null, 2)}

### 🟠 High (${bySeverity.high.length})
${JSON.stringify(bySeverity.high, null, 2)}

### 🟡 Medium (${bySeverity.medium.length})
${JSON.stringify(bySeverity.medium, null, 2)}

### 🟢 Low (${bySeverity.low.length})
${JSON.stringify(bySeverity.low, null, 2)}

Format each feature as a table row with columns: File, Feature, Test Type, Reason.
Make it readable and actionable.`,
  { label: "write-report", phase: "Report" }
);

return {
  summary: {
    files_analyzed: files.length,
    total_features: allFeatures.length,
    unit_tests_needed: byType.unit.length,
    integration_tests_needed: byType.integration.length,
  },
  by_severity: {
    critical: bySeverity.critical.length,
    high: bySeverity.high.length,
    medium: bySeverity.medium.length,
    low: bySeverity.low.length,
  },
  details: bySeverity,
};
