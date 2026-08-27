import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function importSourceAndKind(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): { source: string; kind: "named" | "namespace"; name: string | null } | null {
  const variable = resolveVariable(sourceCode, identifier);
  if (variable === null) return null;
  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
      continue;
    }
    const source = definition.parent.source.value;
    if (definition.node.type === "ImportNamespaceSpecifier") {
      return { source, kind: "namespace", name: null };
    }
    return { source, kind: "named", name: importedName(definition.node) };
  }
  return null;
}

function isFunctionParameter(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
  const variable = resolveVariable(sourceCode, identifier);
  return variable !== null && variable.defs.some((definition) => definition.type === "Parameter");
}

function isVitestOrJestObject(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): expression is ESTree.IdentifierReference {
  if (expression.type !== "Identifier") return false;
  if (
    (expression.name === "vi" || expression.name === "jest") &&
    sourceCode.isGlobalReference(expression)
  ) {
    return true;
  }

  const binding = importSourceAndKind(sourceCode, expression);
  if (binding !== null) {
    return (
      (binding.source === "vitest" && binding.name === "vi") ||
      (binding.source === "@jest/globals" && binding.name === "jest")
    );
  }
  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) {
    return expression.name === "vi" || expression.name === "jest";
  }
  return false;
}

function isNodeTestMockObject(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type === "Identifier") {
    const binding = importSourceAndKind(sourceCode, expression);
    return binding !== null && binding.source === "node:test" && binding.name === "mock";
  }
  if (
    expression.type !== "MemberExpression" ||
    expression.computed ||
    expression.property.type !== "Identifier" ||
    expression.property.name !== "mock" ||
    expression.object.type !== "Identifier"
  ) {
    return false;
  }
  const owner = expression.object;
  const binding = importSourceAndKind(sourceCode, owner);
  if (binding !== null && binding.source === "node:test" && binding.kind === "namespace") {
    return true;
  }
  return isFunctionParameter(sourceCode, owner);
}

function memberMethodName(callee: ESTree.MemberExpression): string | null {
  const property = callee.property;
  if (callee.computed) {
    if (property.type !== "Literal") return null;
    const value = property.value;
    if (
      value === "doMock" ||
      value === "mock" ||
      value === "unstable_mockModule" ||
      value === "module"
    ) {
      return value;
    }
    return null;
  }
  return property.type === "Identifier" ? property.name : null;
}

function moduleMockCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  if (callee.type !== "MemberExpression") return false;
  const method = memberMethodName(callee);
  if (method === null) return false;
  if (moduleMockMethods.has(method) && isVitestOrJestObject(sourceCode, callee.object)) {
    return true;
  }
  return method === "module" && isNodeTestMockObject(sourceCode, callee.object);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest, Jest, and node:test module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
