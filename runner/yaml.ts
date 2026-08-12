/**
 * A deliberately small YAML subset parser.
 *
 * The factory reads YAML in exactly two places — the task contract in an issue body
 * and `.claude/factory/factory.yaml`. Both were previously parsed by separate
 * hand-rolled readers that flattened nesting and could silently mis-parse. One parser
 * with tests is the structurally correct answer: the runner has no runtime dependency
 * beyond node, and a document this parser cannot represent throws instead of quietly
 * producing the wrong object.
 *
 * Supported: nested mappings, sequences of scalars, quoted and bare scalars, numbers,
 * booleans, nulls, comments, and simple inline flow sequences (`[a, b]`).
 * Unsupported (throws, never guesses): block scalars, anchors, flow mappings,
 * sequences of mappings, multiple documents.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export class YamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlError";
  }
}

interface Line {
  indent: number;
  text: string;
  /** 1-based source line, so errors point at something a human can open. */
  n: number;
}

/** Strip a `#` comment without touching a `#` that lives inside a quoted scalar. */
function stripComment(raw: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      out += c;
      if (c === "\\" && quote === '"') {
        out += raw[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(raw[i - 1] ?? " "))) break;
    out += c;
  }
  return out;
}

function tokenize(src: string): Line[] {
  const lines: Line[] = [];
  src.split(/\r?\n/).forEach((raw, idx) => {
    const n = idx + 1;
    if (raw.trim() === "") return;
    // Tolerate document start/end markers; a single document is all we support.
    if (raw.trim() === "---" || raw.trim() === "...") return;
    const leading = raw.slice(0, raw.length - raw.trimStart().length);
    if (leading.includes("\t")) {
      throw new YamlError(`line ${n}: tab indentation is not valid YAML`);
    }
    const stripped = stripComment(raw);
    const text = stripped.trim();
    if (!text) return;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text, n });
  });
  return lines;
}

/** Split a flow sequence body on top-level commas, respecting quotes. */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"') {
        current += body[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "" || parts.length > 0) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function unquote(v: string, n: number): string {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  throw new YamlError(`line ${n}: unbalanced quote in ${JSON.stringify(v)}`);
}

const isQuoted = (v: string) =>
  (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
  (v.startsWith("'") && v.endsWith("'") && v.length >= 2);

export function parseScalar(raw: string, n = 0): YamlValue {
  const v = raw.trim();
  if (v === "") return null;
  if (v === "{}") return {};
  if (v === "[]") return [];
  if (/^[|>]/.test(v)) {
    throw new YamlError(`line ${n}: block scalars (| and >) are not supported`);
  }
  if (v.startsWith("{")) {
    throw new YamlError(`line ${n}: inline flow mappings are not supported`);
  }
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) throw new YamlError(`line ${n}: unterminated flow sequence`);
    return splitFlow(v.slice(1, -1)).map((item) => parseScalar(item, n));
  }
  if (v.startsWith('"') || v.startsWith("'")) return unquote(v, n);
  if (v === "null" || v === "~" || v === "Null" || v === "NULL") return null;
  if (v === "true" || v === "True" || v === "TRUE") return true;
  if (v === "false" || v === "False" || v === "FALSE") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) return Number(v);
  return v;
}

const KEY = /^((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^']|'')*')|(?:[^:\s"'][^:]*?))\s*:(?:\s+(.*))?$/;
/** A sequence item is an inline mapping only with an unquoted `key:` plus whitespace. */
const INLINE_MAP = /^[A-Za-z_][\w.-]*\s*:(?:\s|$)/;

function parseMap(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const out: { [key: string]: YamlValue } = {};
  let i = start;

  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) {
      throw new YamlError(`line ${line.n}: unexpected indentation`);
    }
    if (line.text.startsWith("- ") || line.text === "-") {
      throw new YamlError(`line ${line.n}: sequence item inside a mapping`);
    }

    const m = line.text.match(KEY);
    if (!m) throw new YamlError(`line ${line.n}: expected 'key: value'`);

    const rawKey = m[1].trim();
    const key = isQuoted(rawKey) ? unquote(rawKey, line.n) : rawKey;
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new YamlError(`line ${line.n}: '${key}' is not an allowed key`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new YamlError(`line ${line.n}: duplicate key '${key}'`);
    }
    const rest = (m[2] ?? "").trim();

    if (rest === "") {
      const [child, next] = parseBlock(lines, i + 1, indent + 1);
      out[key] = child;
      i = next;
    } else {
      out[key] = parseScalar(rest, line.n);
      i++;
    }
  }
  return [out, i];
}

function parseSeq(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const out: YamlValue[] = [];
  let i = start;

  while (
    i < lines.length &&
    lines[i].indent === indent &&
    (lines[i].text === "-" || lines[i].text.startsWith("- "))
  ) {
    const line = lines[i];
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();

    if (rest === "") {
      const [child, next] = parseBlock(lines, i + 1, indent + 1);
      out.push(child);
      i = next;
      continue;
    }
    if (!isQuoted(rest) && INLINE_MAP.test(rest)) {
      throw new YamlError(
        `line ${line.n}: sequences of mappings are not supported by the factory contract parser`
      );
    }
    out.push(parseScalar(rest, line.n));
    i++;
  }

  if (i < lines.length && lines[i].indent > indent) {
    throw new YamlError(`line ${lines[i].n}: unexpected indentation after sequence item`);
  }
  return [out, i];
}

function parseBlock(lines: Line[], start: number, minIndent: number): [YamlValue, number] {
  if (start >= lines.length || lines[start].indent < minIndent) return [null, start];
  const indent = lines[start].indent;
  const isSeq = lines[start].text === "-" || lines[start].text.startsWith("- ");
  return isSeq ? parseSeq(lines, start, indent) : parseMap(lines, start, indent);
}

/** Parse a YAML document. Throws `YamlError` rather than returning a partial object. */
export function parseYaml(src: string): YamlValue {
  const lines = tokenize(src);
  if (!lines.length) return null;
  const [value, next] = parseBlock(lines, 0, 0);
  if (next !== lines.length) {
    throw new YamlError(`line ${lines[next].n}: unparsed trailing content`);
  }
  return value;
}

/**
 * True when the body ends inside an unclosed ```yaml block.
 *
 * `fencedYamlBlocks` cannot see such a block at all, so a forgotten closing fence
 * makes the contract silently invisible — and the caller then reports problems about
 * whichever *other* block it did find, sending the author to edit the wrong text.
 * Detecting it separately is what turns that into an accurate message.
 */
export function hasUnterminatedYamlFence(markdown: string): boolean {
  const FENCE = /^[ \t]*```[ \t]*([A-Za-z0-9_-]*)[ \t]*$/;
  let openLanguage: string | null = null;

  for (const line of (markdown ?? "").split(/\r?\n/)) {
    const m = line.match(FENCE);
    if (!m) continue;
    // Inside a fence, any fence line closes it; outside, it opens one.
    openLanguage = openLanguage === null ? m[1].toLowerCase() : null;
  }
  return openLanguage === "yaml" || openLanguage === "yml";
}

/** Extract every fenced ```yaml block from a markdown body, in order. */
export function fencedYamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /^[ \t]*```[ \t]*(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1]);
  return blocks;
}
