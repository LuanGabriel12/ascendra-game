/**
 * Minimal, dependency-free Draft 2020-12 JSON Schema subset evaluator used strictly
 * in contract tests to cross-check static `contracts/neon-carbon/*.schema.json` definitions
 * against runtime `zod` validators (verifying parity and documenting exact static-vs-runtime bounds).
 */

export interface JsonSchemaNode {
  readonly type?: string | ReadonlyArray<string>;
  readonly const?: unknown;
  readonly enum?: ReadonlyArray<unknown>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly oneOf?: ReadonlyArray<JsonSchemaNode>;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchemaNode>>;
}

function resolveRef(root: JsonSchemaNode, ref: string): JsonSchemaNode {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix) || !root.$defs) {
    throw new Error(`Unsupported JSON Schema $ref '${ref}'.`);
  }
  const key = ref.slice(prefix.length);
  const target = root.$defs[key];
  if (!target) {
    throw new Error(`Missing $defs entry '${key}'.`);
  }
  return target;
}

export function validateAgainstJsonSchema(
  rootSchema: JsonSchemaNode,
  candidate: unknown,
  currentSchema: JsonSchemaNode = rootSchema,
): { readonly valid: boolean; readonly errors: ReadonlyArray<string> } {
  const errors: string[] = [];

  if (currentSchema.$ref) {
    return validateAgainstJsonSchema(
      rootSchema,
      candidate,
      resolveRef(rootSchema, currentSchema.$ref),
    );
  }

  if (currentSchema.oneOf) {
    const matches = currentSchema.oneOf.filter(
      (branch) => validateAgainstJsonSchema(rootSchema, candidate, branch).valid,
    );
    if (matches.length !== 1) {
      errors.push(`Expected exactly 1 oneOf branch match, got ${matches.length}.`);
    }
    return { valid: errors.length === 0, errors };
  }

  if (currentSchema.const !== undefined && candidate !== currentSchema.const) {
    errors.push(`Expected const ${String(currentSchema.const)}, got ${String(candidate)}.`);
  }

  if (currentSchema.enum !== undefined && !currentSchema.enum.includes(candidate)) {
    errors.push(`Value '${String(candidate)}' not in enum [${currentSchema.enum.join(", ")}].`);
  }

  if (currentSchema.type !== undefined) {
    const allowedTypes = Array.isArray(currentSchema.type)
      ? currentSchema.type
      : [currentSchema.type];

    const matchesType = allowedTypes.some((t) => {
      if (t === "object") {
        return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
      }
      if (t === "array") {
        return Array.isArray(candidate);
      }
      if (t === "string") {
        return typeof candidate === "string";
      }
      if (t === "boolean") {
        return typeof candidate === "boolean";
      }
      if (t === "integer") {
        return (
          typeof candidate === "number" &&
          Number.isInteger(candidate) &&
          Number.isSafeInteger(candidate)
        );
      }
      if (t === "null") {
        return candidate === null;
      }
      return false;
    });

    if (!matchesType) {
      errors.push(`Type mismatch: expected ${allowedTypes.join("|")}.`);
      return { valid: false, errors };
    }
  }

  if (typeof candidate === "string") {
    if (currentSchema.minLength !== undefined && candidate.length < currentSchema.minLength) {
      errors.push(`String shorter than minLength ${currentSchema.minLength}.`);
    }
    if (currentSchema.maxLength !== undefined && candidate.length > currentSchema.maxLength) {
      errors.push(`String longer than maxLength ${currentSchema.maxLength}.`);
    }
    if (currentSchema.pattern !== undefined) {
      const regex = new RegExp(currentSchema.pattern);
      if (!regex.test(candidate)) {
        errors.push(`String '${candidate}' failed pattern /${currentSchema.pattern}/.`);
      }
    }
  }

  if (typeof candidate === "number") {
    if (currentSchema.minimum !== undefined && candidate < currentSchema.minimum) {
      errors.push(`Number ${candidate} < minimum ${currentSchema.minimum}.`);
    }
    if (currentSchema.maximum !== undefined && candidate > currentSchema.maximum) {
      errors.push(`Number ${candidate} > maximum ${currentSchema.maximum}.`);
    }
  }

  if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    if (currentSchema.required) {
      for (const reqKey of currentSchema.required) {
        if (!(reqKey in record) || record[reqKey] === undefined) {
          errors.push(`Missing required property '${reqKey}'.`);
        }
      }
    }

    const props = currentSchema.properties ?? {};
    if (currentSchema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in props)) {
          errors.push(`Additional property '${key}' is not allowed.`);
        }
      }
    }

    for (const [key, propSchema] of Object.entries(props)) {
      if (key in record && record[key] !== undefined) {
        const sub = validateAgainstJsonSchema(rootSchema, record[key], propSchema);
        for (const err of sub.errors) {
          errors.push(`${key}: ${err}`);
        }
      }
    }
  }

  if (Array.isArray(candidate) && currentSchema.items !== undefined) {
    for (let idx = 0; idx < candidate.length; idx++) {
      const sub = validateAgainstJsonSchema(rootSchema, candidate[idx], currentSchema.items);
      for (const err of sub.errors) {
        errors.push(`[${idx}]: ${err}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
