/** Pure boundary decoders: strict objects, no coercion, stripping, or truncation. */
export const CONTRACT_LIMITS = Object.freeze({
  requestBytes: 24 * 1024 * 1024,
  quoteUnits: 4_000, contextUnits: 1_000, selectorUnits: 2_000, labelUnits: 500,
  editCodePoints: 200_000, editAssets: 20,
  pageDefault: 50, pageMaximum: 100,
});

export const ERROR_STATUS = {
  INVALID_INPUT: 400, MALFORMED_JSON: 400, INVALID_CURSOR: 400,
  UNAUTHORIZED: 401, SCOPE_MISMATCH: 403, NOT_FOUND: 404,
  REQUEST_CONFLICT: 409, VERSION_CONFLICT: 409, REVIEW_ENDED: 409,
  WORK_OUTSTANDING: 409, MESSAGE_IMMUTABLE: 409, THREAD_BUSY: 409,
  SUBMISSION_ABANDONED: 409, ALREADY_HANDLED: 409, RESPONSE_COVERAGE: 409,
  SAVE_EVIDENCE_CONFLICT: 409, EMPTY_SUBMISSION: 400,
  WORKFLOW_REMOVED: 410,
  INPUT_TOO_LARGE: 413, SNAPSHOT_TOO_LARGE: 413,
  INTERNAL_ERROR: 500, STATE_PERSIST_FAILED: 503,
} as const;
export type ContractErrorCode = keyof typeof ERROR_STATUS;
export class ContractError extends Error {
  readonly status: number;
  constructor(readonly code: ContractErrorCode, message: string, readonly path = "$") {
    super(`${path}: ${message}`);
    this.name = "ContractError";
    this.status = ERROR_STATUS[code];
  }
}
export function reject(code: ContractErrorCode, message: string, path = "$"): never {
  throw new ContractError(code, message, path);
}
export interface Schema<T> {
  parse(value: unknown, path?: string): T;
  readonly literalValue?: string | number | boolean;
  readonly fields?: Record<string, Schema<unknown>>;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;
interface OptionalSchema<T> extends Schema<T> { optional: true }
type Shape = Record<string, Schema<unknown>>;
type ObjectValue<S extends Shape> =
  { [K in keyof S as S[K] extends OptionalSchema<unknown> ? never : K]: Infer<S[K]> } &
  { [K in keyof S as S[K] extends OptionalSchema<unknown> ? K : never]?: Infer<S[K]> };

export function schema<T>(parse: (value: unknown, path: string) => T): Schema<T> {
  return { parse: (value, path = "$") => parse(value, path) };
}
export function object<S extends Shape>(shape: S): Schema<ObjectValue<S>> {
  return { fields: shape, ...schema((value, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      return reject("INVALID_INPUT", "Expected a JSON object.", path);
    }
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(shape, key)) reject("INVALID_INPUT", `Unknown field ${key}.`, path);
    }
    const output: Record<string, unknown> = {};
    for (const [key, decoder] of Object.entries(shape)) {
      if (!Object.hasOwn(input, key) && "optional" in decoder) continue;
      output[key] = decoder.parse(input[key], `${path}.${key}`);
    }
    return output as ObjectValue<S>;
  }) };
}
export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return { ...inner, optional: true };
}
export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return schema((value, path) => value === null ? null : inner.parse(value, path));
}
export function literal<const T extends string | number | boolean>(expected: T): Schema<T> {
  return { literalValue: expected, ...schema((value, path) =>
    value === expected ? expected : reject("INVALID_INPUT", `Expected ${expected}.`, path)) };
}
export function enumeration<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return schema((value, path) => typeof value === "string" && values.includes(value)
    ? value : reject("INVALID_INPUT", `Expected ${values.join(" | ")}.`, path));
}
export const booleanValue = schema<boolean>((value, path) => typeof value === "boolean"
  ? value : reject("INVALID_INPUT", "Expected a boolean.", path));
export function integer(min = 0, max = Number.MAX_SAFE_INTEGER): Schema<number> {
  return schema((value, path) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value : reject("INVALID_INPUT", `Expected an integer in ${min}..${max}.`, path));
}
export function text(max = Infinity, nonempty = true, codePoints = false): Schema<string> {
  return schema((value, path) => {
    if (typeof value !== "string" || (nonempty && !value.trim())) reject("INVALID_INPUT", "Expected nonempty text.", path);
    const length = codePoints ? [...value].length : value.length;
    if (length > max) reject("INPUT_TOO_LARGE", `Text exceeds ${max} ${codePoints ? "code points" : "UTF-16 units"}.`, path);
    return value;
  });
}
export const id = text();
export const version = integer(1);
export const timestamp = integer();
export function array<T>(inner: Schema<T>, max = Infinity): Schema<T[]> {
  return schema((value, path) => {
    if (!Array.isArray(value)) reject("INVALID_INPUT", "Expected an array.", path);
    if (value.length > max) reject("INPUT_TOO_LARGE", `Array exceeds ${max} entries.`, path);
    return Array.from(value, (entry, index) => inner.parse(entry, `${path}[${index}]`));
  });
}
export function union<const S extends readonly Schema<unknown>[]>(...members: S): Schema<Infer<S[number]>> {
  const discriminant = Object.keys(members[0]?.fields ?? {}).find((key) =>
    members.every((member) => member.fields?.[key]?.literalValue !== undefined) &&
    new Set(members.map((member) => member.fields?.[key]?.literalValue)).size === members.length);
  return schema((value, path) => {
    if (discriminant && value && typeof value === "object") {
      const tag = (value as Record<string, unknown>)[discriminant];
      const selected = members.find((member) => member.fields?.[discriminant]?.literalValue === tag);
      if (!selected) reject("INVALID_INPUT", `Unknown ${discriminant}.`, path);
      return selected.parse(value, path) as Infer<S[number]>;
    }
    const errors: ContractError[] = [];
    for (const member of members) {
      try { return member.parse(value, path) as Infer<S[number]>; }
      catch (error) {
        if (!(error instanceof ContractError)) throw error;
        errors.push(error);
      }
    }
    throw errors.find((error) => error.code === "INPUT_TOO_LARGE") ??
      new ContractError("INVALID_INPUT", "No matching contract variant.", path);
  });
}
export function refine<T>(inner: Schema<T>, check: (value: T) => void): Schema<T> {
  return { ...inner, ...schema((value, path) => {
    const parsed = inner.parse(value, path);
    check(parsed);
    return parsed;
  }) };
}
export function unique(values: readonly string[], path = "$"): void {
  if (new Set(values).size !== values.length) reject("INVALID_INPUT", "Duplicate identity.", path);
}
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export function parseContractJson<T>(raw: string, decoder: Schema<T>): T {
  if (utf8Length(raw) > CONTRACT_LIMITS.requestBytes) reject("INPUT_TOO_LARGE", "Request exceeds 24 MiB UTF-8.");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return reject("MALFORMED_JSON", "Expected a JSON document.");
  }
  return decoder.parse(value);
}

/** Key order is immaterial; array order and exact text are part of a request. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return reject("INVALID_INPUT", "Expected JSON data.");
}

export const failureSchema = refine(object({
  ok: literal(false),
  error: object({
    code: enumeration(Object.keys(ERROR_STATUS) as ContractErrorCode[]),
    message: text(), status: integer(400, 599), retryable: booleanValue,
  }),
}), ({ error }) => {
  if (error.status !== ERROR_STATUS[error.code] || error.retryable !== (error.code === "STATE_PERSIST_FAILED")) {
    reject("INVALID_INPUT", "Error code/status/retryability mismatch.");
  }
});
export type ContractFailure = Infer<typeof failureSchema>;
export function contractFailure(error: ContractError): ContractFailure {
  return failureSchema.parse({ ok: false, error: {
    code: error.code, message: error.message, status: error.status, retryable: error.code === "STATE_PERSIST_FAILED",
  } });
}

export function transportOutcomeSchema<T>(accepted: Schema<T>) {
  return union(
    object({ state: literal("accepted"), value: accepted }),
    object({ state: literal("rejected"), failure: failureSchema }),
    object({ state: literal("unknown"), requestId: id, reason: enumeration([
      "timeout", "disconnected", "invalid-response", "unavailable",
    ]) }),
  );
}
