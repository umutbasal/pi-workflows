export const meta = {
  name: "review-tests",
  description: "Review all test files, tag useless ones for removal",
  phases: [
    { title: "Discover", detail: "find all test files" },
    { title: "Analyze", detail: "agent reads each test and decides if useful" },
    { title: "Report", detail: "compile results" },
  ],
};

const ANALYSIS_SCHEMA = {
  type: "object",
  required: ["verdict", "reason", "test_count"],
  properties: {
    verdict: { enum: ["useful", "useless", "uncertain"] },
    reason: { type: "string", description: "One-line explanation" },
    test_count: { type: "integer", description: "Number of test cases in file" },
    covers: { type: "string", description: "What functionality this tests" },
  },
};

export default async function ({ agent, pipeline, log, args }) {
  const pattern = args?.pattern ?? "**/*.test.{ts,js,tsx,jsx}";
  const dir = args?.dir ?? ".";

  // Phase 1: Discover test files
  log("Discovering test files...");
  const discovery = await agent(
    `Find all test files matching the glob pattern "${pattern}" in "${dir}". Use bash with find or fd. Return a JSON array of file paths relative to the project root.`,
    {
      label: "discover-tests",
      phase: "Discover",
      schema: { type: "array", items: { type: "string" } },
    },
  );

  const files = Array.isArray(discovery) ? discovery : [];
  if (files.length === 0) return { error: "No test files found" };
  log(`Found ${files.length} test file(s), analyzing...`);

  // Phase 2: Analyze each test file in parallel
  const results = await pipeline(
    files,
    (file) =>
      agent(
        `Read the test file at "${file}" and analyze whether it's a useful test. A test is "useless" if it:
- Only tests trivial getters/setters with no logic
- Is a snapshot test that just checks render output without assertions
- Tests implementation details that would break on any refactor
- Is a duplicate of another test
- Tests mock behavior rather than real functionality
- Has no meaningful assertions (e.g. just checks truthiness)

A test is "useful" if it:
- Tests actual business logic or edge cases
- Catches real bugs or regressions
- Tests integration between components
- Validates error handling

Read the file, count the test cases, and give your verdict.`,
        {
          label: `analyze:${file}`,
          phase: "Analyze",
          schema: ANALYSIS_SCHEMA,
        },
      ),
  );

  // Phase 3: Compile report
  const analyzed = files.map((file, i) => ({
    file,
    ...(results[i] ?? { verdict: "uncertain", reason: "analysis failed" }),
  }));

  const useless = analyzed.filter((r) => r.verdict === "useless");
  const useful = analyzed.filter((r) => r.verdict === "useful");
  const uncertain = analyzed.filter((r) => r.verdict === "uncertain");

  log(`Done: ${useless.length} useless, ${useful.length} useful, ${uncertain.length} uncertain`);

  return {
    summary: {
      total: files.length,
      useless: useless.length,
      useful: useful.length,
      uncertain: uncertain.length,
    },
    useless,
    uncertain,
    useful,
  };
}
