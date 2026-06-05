import type { AgentToolCall, JsonValue } from "./types.ts";

/**
 * Tool-failure recovery primitives.
 *
 * The agent must never silently skip a failed tool call. These helpers let the
 * runtime detect failures consistently, classify them, repair common typed
 * Roblox property mistakes, and synthesize a safe `execute_luau` fallback for
 * simple scoped mutations. They are intentionally pure so they can be unit
 * tested without a live Studio session.
 */

export type FailureClass =
  | "none"
  | "denied"
  | "cancelled"
  | "conflict"
  | "type_mismatch"
  | "not_found"
  | "generic";

export type UnresolvedObligation = {
  /** Stable key: `${toolName}::${scope}`. */
  key: string;
  toolName: string;
  scope: string;
  /** Normalized instance path the failed call targeted, when applicable. */
  path?: string;
  error: string;
  hint?: string;
  class: FailureClass;
};

const asRecord = (value: JsonValue): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * A tool result is a failure when it signals it did not accomplish its goal:
 * `{ success: false }`, a non-empty `error` string, `{ conflict: true }`,
 * `{ denied: true }`, or `{ cancelled: true }`. Plain success payloads return
 * false.
 */
export function isFailedToolResult(output: JsonValue): boolean {
  const r = asRecord(output);
  if (!r) return false;
  if (r.success === false) return true;
  if (r.conflict === true) return true;
  if (r.denied === true) return true;
  if (r.cancelled === true) return true;
  if (typeof r.error === "string" && r.error.length > 0) return true;
  return false;
}

export function failureMessage(output: JsonValue): string {
  const r = asRecord(output);
  if (!r) return "Tool failed";
  if (typeof r.error === "string" && r.error) return r.error;
  if (typeof r.reason === "string" && r.reason) return r.reason;
  if (r.conflict === true) return "Concurrent edit conflict";
  return "Tool failed";
}

export function failureHint(output: JsonValue): string | undefined {
  const r = asRecord(output);
  if (r && typeof r.hint === "string" && r.hint) return r.hint;
  return undefined;
}

export function classifyFailure(output: JsonValue): FailureClass {
  const r = asRecord(output);
  if (!r) return "none";
  if (r.denied === true) return "denied";
  if (r.cancelled === true) return "cancelled";
  if (r.conflict === true) return "conflict";
  if (!isFailedToolResult(output)) return "none";
  const error = failureMessage(output).toLowerCase();
  if (/\bexpected\b|got string|cannot convert|is not a valid|unable to assign|invalid value/.test(error)) {
    return "type_mismatch";
  }
  if (/not found|does not exist|no such|unknown instance|unknown tool/.test(error)) {
    return "not_found";
  }
  return "generic";
}

/**
 * A failure that the model/runtime is still obligated to resolve. User denials
 * and cancellations are decided outcomes, not outstanding work.
 */
export function isObligation(failureClass: FailureClass): boolean {
  return failureClass !== "none" && failureClass !== "denied" && failureClass !== "cancelled";
}

const isColorProperty = (property: string) => /color/i.test(property);

/** Parse the numeric args out of a `Ctor.method(a, b, c, ...)` expression. */
const parseArgs = (value: string, ctor: RegExp): number[] | null => {
  const match = ctor.exec(value.trim());
  if (!match) return null;
  const inner = match[1];
  const parts = inner.split(",").map((p) => Number(p.trim()));
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts;
};

const allInts = (nums: number[]) => nums.every((n) => Number.isInteger(n));
const inByteRange = (nums: number[]) => nums.every((n) => n >= 0 && n <= 255);

/**
 * Convert a model-supplied property value into the bare string format the
 * Studio plugin's `set_property` handler accepts, when possible. Returns null
 * when the value cannot be expressed in a plugin-native format — the caller
 * should then fall back to `execute_luau` via {@link toLuauAssignment}.
 *
 * The plugin accepts: "true"/"false", plain numbers, `r, g, b` (Color3 when the
 * property name contains "Color" and values <= 255, else Vector3 — integers
 * only), "#RRGGBB", and "Enum.X.Y". So we normalize the common model mistakes
 * `Color3.fromRGB(...)`, `Color3.new(...)`, and `Vector3.new(...)` into that
 * form, mirroring the plugin's own parsing rules exactly.
 */
export function repairPropertyValue(property: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();

  const fromRgb = parseArgs(trimmed, /^Color3\.fromRGB\(([^()]*)\)$/i);
  if (fromRgb && fromRgb.length === 3 && allInts(fromRgb) && inByteRange(fromRgb) && isColorProperty(property)) {
    return fromRgb.join(", ");
  }

  const colorNew = parseArgs(trimmed, /^Color3\.new\(([^()]*)\)$/i);
  if (colorNew && colorNew.length === 3 && isColorProperty(property)) {
    const rgb = colorNew.map((n) => Math.round(n * 255));
    if (inByteRange(rgb)) return rgb.join(", ");
  }

  const vec3 = parseArgs(trimmed, /^Vector3\.new\(([^()]*)\)$/i);
  if (vec3 && vec3.length === 3 && allInts(vec3) && !isColorProperty(property)) {
    return vec3.join(", ");
  }

  return null;
}

// Safe Luau value expressions for the execute_luau fallback. Only digits,
// commas, dots, spaces, and minus signs may appear inside constructor parens,
// so no statement separators or assignments can be smuggled in.
const SAFE_NUM_ARGS = String.raw`[-\d.,\s]*`;
const SAFE_VALUE_RE = new RegExp(
  "^(?:" +
    [
      `Color3\\.fromRGB\\(${SAFE_NUM_ARGS}\\)`,
      `Color3\\.new\\(${SAFE_NUM_ARGS}\\)`,
      `Vector3\\.new\\(${SAFE_NUM_ARGS}\\)`,
      `Vector2\\.new\\(${SAFE_NUM_ARGS}\\)`,
      `CFrame\\.new\\(${SAFE_NUM_ARGS}\\)`,
      `CFrame\\.Angles\\(${SAFE_NUM_ARGS}\\)`,
      `UDim2\\.new\\(${SAFE_NUM_ARGS}\\)`,
      `UDim\\.new\\(${SAFE_NUM_ARGS}\\)`,
      `NumberRange\\.new\\(${SAFE_NUM_ARGS}\\)`,
      `Enum\\.[A-Za-z0-9_]+\\.[A-Za-z0-9_]+`,
      `BrickColor\\.new\\("[A-Za-z0-9 ]+"\\)`,
      "true",
      "false",
      String.raw`-?\d+(?:\.\d+)?`,
      `"[^"\\\\]*"`,
    ].join("|") +
    ")$",
  "i",
);

/**
 * Build a safe Luau assignment for the `execute_luau` fallback when
 * `set_property` cannot be repaired into a plugin-native value (e.g. CFrame,
 * UDim2, Color3 on a non-"Color" property like Lighting.Ambient). Returns null
 * when the value is not a recognized safe literal/constructor.
 *
 * Example: ("game.Lighting", "FogColor", "Color3.fromRGB(40, 40, 50)") ->
 *   `game.Lighting.FogColor = Color3.fromRGB(40, 40, 50)`
 */
export function toLuauAssignment(path: string, property: string, value: unknown): string | null {
  const expr = toLuauExpression(property, value);
  if (!expr) return null;
  if (!/^[A-Za-z0-9_.]+$/.test(path) || !/^[A-Za-z0-9_]+$/.test(property)) return null;
  return `${path}.${property} = ${expr}`;
}

/** Normalize a model value string into a safe Luau expression, or null. */
export function toLuauExpression(property: string, value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (SAFE_VALUE_RE.test(trimmed)) return trimmed;

  // Bare "r, g, b" -> Color3/Vector3 depending on property name (matches plugin).
  const bare = trimmed.split(",").map((p) => Number(p.trim()));
  if (bare.length === 3 && bare.every((n) => !Number.isNaN(n))) {
    if (isColorProperty(property) && allInts(bare) && inByteRange(bare)) {
      return `Color3.fromRGB(${bare.join(", ")})`;
    }
    return `Vector3.new(${bare.join(", ")})`;
  }

  // "#RRGGBB"
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex && isColorProperty(property)) {
    const r = parseInt(hex[1].slice(0, 2), 16);
    const g = parseInt(hex[1].slice(2, 4), 16);
    const b = parseInt(hex[1].slice(4, 6), 16);
    return `Color3.fromRGB(${r}, ${g}, ${b})`;
  }

  return null;
}

export type RecoveryCandidate = {
  name: string;
  input: Record<string, unknown>;
  /** Short human-readable description for progress notes. */
  note: string;
};

/**
 * Given a failed primary tool call, produce ordered repair candidates to try.
 * Type-mismatch property failures are repaired in place first, then fall back
 * to a scoped `execute_luau` assignment. General to all callers — returns an
 * empty list when no automatic repair is known.
 */
export function buildRecoveryCandidates(
  call: AgentToolCall,
  output: JsonValue,
  normalizePath: (raw: string) => string,
): RecoveryCandidate[] {
  const cls = classifyFailure(output);
  if (!isObligation(cls)) return [];
  const candidates: RecoveryCandidate[] = [];

  if (call.name === "mcp__roblox_studio__set_property") {
    const property = String(call.input.property ?? "");
    const value = call.input.value;
    const rawPath = String(call.input.path ?? "game");
    const repaired = repairPropertyValue(property, value);
    if (repaired !== null && repaired !== value) {
      candidates.push({
        name: call.name,
        input: { ...call.input, value: repaired },
        note: `corrected ${property} value to plugin format "${repaired}"`,
      });
    }
    const assignment = toLuauAssignment(normalizePath(rawPath), property, value);
    if (assignment) {
      candidates.push({
        name: "mcp__roblox_studio__execute_luau",
        input: { code: assignment },
        note: `fallback via execute_luau: ${assignment}`,
      });
    }
    return candidates;
  }

  if (call.name === "mcp__roblox_studio__bulk_set_property") {
    const ops = Array.isArray(call.input.operations) ? (call.input.operations as Array<Record<string, unknown>>) : [];
    let changed = false;
    const repairedOps = ops.map((op) => {
      const repaired = repairPropertyValue(String(op.property ?? ""), op.value);
      if (repaired !== null && repaired !== op.value) {
        changed = true;
        return { ...op, value: repaired };
      }
      return op;
    });
    if (changed) {
      candidates.push({
        name: call.name,
        input: { ...call.input, operations: repairedOps },
        note: "corrected bulk property values to plugin format",
      });
    }
    return candidates;
  }

  return candidates;
}

/** The read tool + path that can verify a mutation, when one exists. */
export function verificationFor(
  call: AgentToolCall,
  normalizePath: (raw: string) => string,
): { name: string; input: Record<string, unknown> } | null {
  if (call.name === "mcp__roblox_studio__set_property") {
    return { name: "mcp__roblox_studio__get_properties", input: { path: normalizePath(String(call.input.path ?? "game")) } };
  }
  if (call.name === "mcp__roblox_studio__write_script" || call.name === "mcp__roblox_studio__edit_script") {
    return { name: "mcp__roblox_studio__read_script", input: { path: normalizePath(String(call.input.path ?? "game")) } };
  }
  return null;
}

export function buildUnresolvedCorrection(obligations: UnresolvedObligation[]): string {
  const lines = obligations.map((o) => {
    const hint = o.hint ? ` Hint: ${o.hint}` : "";
    return `- ${o.toolName} (${o.scope}) FAILED: ${o.error}.${hint}`;
  });
  return [
    "You have UNRESOLVED failed tool calls. You must not finish while these remain unresolved.",
    "",
    ...lines,
    "",
    "For each one: correct the input and retry, or use an alternative tool (e.g. execute_luau for a typed property the plugin cannot parse). Do not ignore these. Do not summarize completion until they succeed or are provably impossible.",
  ].join("\n");
}
