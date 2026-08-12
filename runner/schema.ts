/**
 * A minimal JSON Schema validator covering exactly the keywords used by
 * `runner/task-schema.json`.
 *
 * The schema file previously existed as documentation only — nothing loaded it, so
 * `additionalProperties: false`, the id pattern, and the budget bounds were unenforced
 * while the dispatcher hand-checked a different, weaker set of rules. One declared
 * contract, actually enforced, is the point.
 *
 * Unknown keywords throw at validator-construction time rather than being ignored:
 * a schema keyword that silently does nothing is how a contract rots.
 */

export interface Schema {
  [keyword: string]: unknown;
}

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
]);

const SUPPORTED = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "enum",
  "minimum",
  "maximum",
]);

function assertSupported(schema: Schema, path: string): void {
  for (const keyword of Object.keys(schema)) {
    if (ANNOTATIONS.has(keyword) || SUPPORTED.has(keyword)) continue;
    throw new Error(`schema at ${path || "#"}: unsupported keyword '${keyword}'`);
  }
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties as Record<string, Schema>)) {
      assertSupported(sub, `${path}/${key}`);
    }
  }
  if (schema.items) assertSupported(schema.items as Schema, `${path}/items`);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    assertSupported(schema.additionalProperties as Schema, `${path}/additionalProperties`);
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function check(value: unknown, schema: Schema, path: string, out: string[]): void {
  const at = path || "(root)";

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!expected.some((t) => typeMatches(value, t))) {
      out.push(`${at}: expected ${expected.join(" or ")}, got ${typeOf(value)}`);
      return; // Every other keyword assumes the type held.
    }
  }

  if (schema.enum !== undefined) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => a === value)) {
      out.push(`${at}: '${String(value)}' is not one of ${allowed.map(String).join(", ")}`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) {
      out.push(`${at}: shorter than minimum length ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) {
      out.push(`${at}: longer than maximum length ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string).test(value)) {
      out.push(`${at}: does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) {
      out.push(`${at}: ${value} is below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > (schema.maximum as number)) {
      out.push(`${at}: ${value} is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) {
      out.push(`${at}: needs at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) {
      out.push(`${at}: allows at most ${schema.maxItems} item(s), got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => check(item, schema.items as Schema, `${path}[${i}]`, out));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;

    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj) || obj[key] === null || obj[key] === undefined) {
        out.push(`${at}: missing required property '${key}'`);
      }
    }
    for (const [key, sub] of Object.entries(obj)) {
      if (properties[key]) {
        if (sub !== null && sub !== undefined) check(sub, properties[key], `${path}/${key}`, out);
      } else if (schema.additionalProperties === false) {
        out.push(`${at}: unexpected property '${key}'`);
      } else if (typeof schema.additionalProperties === "object") {
        check(sub, schema.additionalProperties as Schema, `${path}/${key}`, out);
      }
    }
  }
}

/**
 * Validate `value` against `schema`, returning every problem found.
 * An empty array means the value satisfies the contract.
 */
export function validate(value: unknown, schema: Schema): string[] {
  assertSupported(schema, "");
  const problems: string[] = [];
  check(value, schema, "", problems);
  return problems;
}
