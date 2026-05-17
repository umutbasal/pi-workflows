import { describe, test, expect } from "bun:test";
import { extractMeta, extractBody, extractArgsHint } from "./loader";

describe("extractMeta", () => {
  test("extracts meta from a standard workflow file", () => {
    const source = `export const meta = {
  name: "review",
  description: "Review files for bugs",
  phases: [
    { title: "Discover", detail: "find source files" },
    { title: "Review", detail: "review each file" },
  ],
};

phase("Discover");
const files = await agent("find files");
`;
    const meta = extractMeta(source);
    expect(meta).toEqual({
      name: "review",
      description: "Review files for bugs",
      phases: [
        { title: "Discover", detail: "find source files" },
        { title: "Review", detail: "review each file" },
      ],
    });
  });

  test("returns null if no export const meta", () => {
    const source = `const x = 1;\nreturn x;`;
    expect(extractMeta(source)).toBeNull();
  });

  test("returns null if meta has no name field", () => {
    const source = `export const meta = { description: "no name" };`;
    expect(extractMeta(source)).toBeNull();
  });

  test("handles nested braces in meta", () => {
    const source = `export const meta = {
  name: "test",
  description: "desc",
  phases: [{ title: "A", detail: "{ nested }" }],
};`;
    const meta = extractMeta(source);
    expect(meta!.name).toBe("test");
  });
});

describe("extractArgsHint", () => {
  test("extracts args hint from comment", () => {
    const source = `// args: { files: Array<{zig: string, loc: number}>, repo: string }
const REPO = (args && args.repo) || "/root/bun-5";`;
    expect(extractArgsHint(source)).toBe(
      "{ files: Array<{zig: string, loc: number}>, repo: string }",
    );
  });

  test("returns undefined when no args comment exists", () => {
    const source = `const x = 1;\nreturn x;`;
    expect(extractArgsHint(source)).toBeUndefined();
  });

  test("is case-insensitive", () => {
    const source = `// Args: { name: string }`;
    expect(extractArgsHint(source)).toBe("{ name: string }");
  });
});

describe("extractBody", () => {
  test("removes the export const meta block", () => {
    const source = `export const meta = {
  name: "test",
  description: "a workflow",
};

phase("Build");
return 42;
`;
    const body = extractBody(source);
    expect(body).not.toContain("export const meta");
    expect(body).toContain("phase(\"Build\")");
    expect(body).toContain("return 42");
  });

  test("preserves code before and after meta", () => {
    const source = `const X = 10;
export const meta = {
  name: "test",
  description: "desc",
};
const Y = 20;
return X + Y;
`;
    const body = extractBody(source);
    expect(body).toContain("const X = 10");
    expect(body).toContain("const Y = 20");
    expect(body).toContain("return X + Y");
  });
});
