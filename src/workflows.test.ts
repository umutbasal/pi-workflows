import { describe, test, expect, mock } from "bun:test";
import { readdir, readFile } from "fs/promises";
import { join, parse as parsePath } from "path";
import { parse as parseJS } from "@babel/parser";
import { extractMeta, extractBody } from "./loader";
import { executeWorkflow } from "./executor";
import type { WorkflowRuntime } from "./types";

const WORKFLOWS_DIR = join(import.meta.dir, "../testdata/workflows");

const files = await readdir(WORKFLOWS_DIR);
const workflowFiles = files.filter((f) => {
  const ext = parsePath(f).ext.toLowerCase();
  return [".ts", ".js", ".mts", ".mjs"].includes(ext);
});

function parseWorkflow(source: string): ReturnType<typeof parseJS> {
  return parseJS(source, {
    sourceType: "module",
    plugins: ["typescript", "topLevelAwait"],
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
}

function stubFromSchema(schema: any): any {
  if (!schema) return "mock";
  switch (schema.type) {
    case "object": {
      const obj: any = {};
      const props = schema.properties || {};
      for (const [key, prop] of Object.entries<any>(props)) {
        obj[key] = stubFromSchema(prop);
      }
      return obj;
    }
    case "array":
      if (schema.items) return [stubFromSchema(schema.items)];
      return ["mock"];
    case "string":
      if (schema.enum) return schema.enum[0];
      return "mock";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    default:
      if (schema.enum) return schema.enum[0];
      return "mock";
  }
}

function inferMockArgs(ast: ReturnType<typeof parseJS>): Record<string, any> {
  const args: Record<string, any> = {};

  const varToArgKey = new Map<string, string>();
  const arrayVars = new Set<string>();
  const stringIteratedVars = new Set<string>();
  const varPropertyAccess = new Map<string, Map<string, string>>();

  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    if (node.type === "VariableDeclarator" && node.id?.name) {
      const varName = node.id.name;
      const init = node.init;
      const argKey = extractArgKey(init);
      if (argKey) {
        varToArgKey.set(varName, argKey);
        if (isArrayDefault(init)) arrayVars.add(varName);
      }
    }

    if (node.type === "IfStatement" && node.test?.type === "UnaryExpression" && node.test.operator === "!") {
      const arg = node.test.argument;
      const consequent = node.consequent;
      const isGuard = consequent?.type === "ThrowStatement"
        || consequent?.type === "ReturnStatement"
        || (consequent?.type === "BlockStatement" && consequent.body?.[0]?.type === "ThrowStatement");

      if (isGuard) {
        if (arg?.type === "MemberExpression" && arg.property?.name === "length" && arg.object?.type === "Identifier") {
          arrayVars.add(arg.object.name);
        } else if (arg?.type === "Identifier") {
          const key = varToArgKey.get(arg.name);
          if (key && !(key in args)) args[key] = "/tmp/mock";
        } else if (arg?.type === "MemberExpression") {
          const key = extractDirectArgAccess(arg);
          if (key && !(key in args)) args[key] = "/tmp/mock";
        }
      }
    }

    if (node.type === "LogicalExpression" && node.operator === "||") {
      const key = extractDirectArgAccess(node.left);
      if (key && isThrowExpression(node.right) && !(key in args)) {
        args[key] = "mock";
      }
    }

    // Detect for-of: for (const x of ARR) { x.prop / x.split() }
    if (node.type === "ForOfStatement" && node.right?.type === "Identifier") {
      const collectionVar = node.right.name;
      const iterVarName = node.left?.declarations?.[0]?.id?.name;
      if (iterVarName) {
        const bodyStr = JSON.stringify(node.body);
        if (bodyStr.includes('"split"') || bodyStr.includes('"replace"') || bodyStr.includes('"startsWith"')) {
          stringIteratedVars.add(collectionVar);
        }
        collectPropertyAccess(node.body, iterVarName, collectionVar);
      }
    }

    // Detect .map/.forEach callbacks: ARR.map(x => x.prop)
    if (node.type === "CallExpression"
      && node.callee?.type === "MemberExpression"
      && ["map", "forEach", "filter", "flatMap"].includes(node.callee.property?.name)
      && node.callee.object?.type === "Identifier") {
      const collectionVar = node.callee.object.name;
      const callback = node.arguments?.[0];
      const paramName = callback?.params?.[0]?.name;
      if (paramName && callback.body) {
        collectPropertyAccess(callback.body, paramName, collectionVar);
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      walk(node[key]);
    }
  }

  function collectPropertyAccess(node: any, itemVar: string, collectionVar: string, parent?: any) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(n => collectPropertyAccess(n, itemVar, collectionVar, parent)); return; }

    if (node.type === "MemberExpression" && !node.computed
      && node.object?.type === "Identifier" && node.object.name === itemVar
      && node.property?.type === "Identifier") {
      if (!varPropertyAccess.has(collectionVar)) varPropertyAccess.set(collectionVar, new Map());
      const propName = node.property.name;
      const map = varPropertyAccess.get(collectionVar)!;
      if (!map.has(propName)) {
        map.set(propName, inferTypeFromContext(node, parent));
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      collectPropertyAccess(node[key], itemVar, collectionVar, node);
    }
  }

  function inferTypeFromContext(memberExpr: any, parent: any): string {
    if (!parent) return "string";
    // item.prop.split / item.prop.replace → string
    if (parent.type === "MemberExpression" && parent.object === memberExpr) {
      const method = parent.property?.name;
      if (["split", "replace", "startsWith", "endsWith", "includes", "trim", "toLowerCase", "toUpperCase"].includes(method))
        return "string";
      if (["map", "filter", "flatMap", "forEach", "reduce", "join", "push", "concat", "slice", "find", "some", "every"].includes(method))
        return "array";
      if (method === "length") return "array";
    }
    // used in arithmetic
    if (parent.type === "BinaryExpression" && ["-", "*", "/", "%"].includes(parent.operator))
      return "number";
    if (parent.type === "BinaryExpression" && parent.operator === "+"
      && (parent.left?.type === "NumericLiteral" || parent.right?.type === "NumericLiteral"))
      return "number";
    return "string";
  }

  function extractArgKey(node: any): string | undefined {
    if (!node) return undefined;
    if (node.type === "LogicalExpression" && node.operator === "||") {
      return extractDirectArgAccess(node.left) || extractArgKey(node.left);
    }
    if (node.type === "LogicalExpression" && node.operator === "&&") {
      return extractDirectArgAccess(node.right);
    }
    return extractDirectArgAccess(node);
  }

  function extractDirectArgAccess(node: any): string | undefined {
    if (node?.type === "MemberExpression" && !node.computed
      && node.property?.type === "Identifier") {
      const obj = node.object;
      if (obj?.type === "Identifier" && (obj.name === "args" || obj.name === "A")) {
        return node.property.name;
      }
    }
    return undefined;
  }

  function isArrayDefault(node: any): boolean {
    if (node?.type === "LogicalExpression" && node.operator === "||") {
      const right = node.right;
      return right?.type === "ArrayExpression" && right.elements?.length === 0;
    }
    return false;
  }

  function isThrowExpression(node: any): boolean {
    if (node?.type === "CallExpression" && node.callee?.type === "ArrowFunctionExpression") {
      const body = node.callee.body;
      if (body?.type === "BlockStatement") {
        return body.body?.some((s: any) => s.type === "ThrowStatement");
      }
      if (body?.type === "ThrowStatement") return true;
    }
    return false;
  }

  function buildStubItem(collectionVar: string): any {
    if (stringIteratedVars.has(collectionVar)) return "mock::mock";
    const props = varPropertyAccess.get(collectionVar);
    if (!props || props.size === 0) return { _: "mock" };
    const obj: any = {};
    for (const [prop, type] of props) {
      if (["length", "map", "filter", "forEach", "flatMap", "reduce", "join", "slice", "find", "some", "every", "push", "concat"].includes(prop)) continue;
      switch (type) {
        case "number": obj[prop] = 0; break;
        case "array": obj[prop] = ["mock::mock"]; break;
        default: obj[prop] = "mock"; break;
      }
    }
    return obj;
  }

  walk(ast.program);

  // Build args for array vars
  for (const varName of arrayVars) {
    const key = varToArgKey.get(varName);
    if (key && !(key in args)) {
      args[key] = [buildStubItem(varName)];
    }
  }

  // Upgrade string-iterated arrays
  for (const [varName, key] of varToArgKey) {
    if (stringIteratedVars.has(varName) && key in args && Array.isArray(args[key])) {
      args[key] = ["mock::mock"];
    }
  }

  return args;
}

function mockRuntime(): WorkflowRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    agent: mock(async (prompt: string, options?: any) => {
      calls.push(prompt);
      if (options?.schema) return stubFromSchema(options.schema);
      return "mock";
    }),
    log: mock((msg: string) => { calls.push(`log:${msg}`); }),
    phase: mock((name: string) => { calls.push(`phase:${name}`); }),
    parallel: mock(async (thunks) => Promise.all(thunks.map((t) => t()))),
    pipeline: mock(async (items, ...stages) => {
      const arr = Array.isArray(items) ? items : [items];
      let results = arr.map((item) => ({ _item: item, _result: item }));
      for (const stage of stages) {
        results = await Promise.all(
          results.map(async (entry, index) => {
            try {
              const output = await stage(entry._result, entry._item, index);
              return { _item: entry._item, _result: output };
            } catch {
              return { _item: entry._item, _result: entry._result };
            }
          }),
        );
      }
      return results.map((r) => r._result);
    }),
  };
}

describe("workflow validation", () => {
  for (const file of workflowFiles) {
    const name = parsePath(file).name;
    const shouldFail = name.startsWith("invalid_");

    test(name, async () => {
      const source = await readFile(join(WORKFLOWS_DIR, file), "utf-8");
      const meta = extractMeta(source);

      if (shouldFail) {
        expect(meta).toBeNull();
      } else {
        expect(meta).not.toBeNull();
        expect(meta!.name).toBeTruthy();
        expect(() => parseWorkflow(source)).not.toThrow();
      }
    });
  }
});

describe("workflow execution (mocked agent)", () => {
  for (const file of workflowFiles) {
    const name = parsePath(file).name;
    if (name.startsWith("invalid_")) continue;

    test(name, async () => {
      const source = await readFile(join(WORKFLOWS_DIR, file), "utf-8");
      const ast = parseWorkflow(source);
      const body = extractBody(source);
      const runtime = mockRuntime();
      const mockArgs = inferMockArgs(ast);

      try {
        await executeWorkflow(body, runtime, mockArgs);
      } catch (e: any) {
        if (e instanceof SyntaxError) throw e;
        if (e?.message?.includes("is not a function")) throw e;
      }
    });
  }
});
