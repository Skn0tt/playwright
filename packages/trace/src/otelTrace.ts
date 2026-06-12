/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// A small, isomorphic subset of the OTLP/JSON data model, plus the helpers we
// need to serialise Playwright's existing trace facts into it. This is not the
// OpenTelemetry SDK: we do not instrument anything at runtime. We just want our
// archive to be OTLP-shaped on disk so the trace viewer can read it back.
//
// Everything here must run in the browser/service-worker too, so there are no
// Node built-ins (no `crypto`) - id generation is a synchronous BigInt hash.

// --- OTLP/JSON model (subset) -----------------------------------------------

// OTLP/JSON encodes int64 as a decimal string and double as a number.
export type OtlpAnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
  bytesValue?: string;
};

export type OtlpKeyValue = {
  key: string;
  value: OtlpAnyValue;
};

export type OtlpResource = {
  attributes: OtlpKeyValue[];
  droppedAttributesCount?: number;
};

export type OtlpInstrumentationScope = {
  name: string;
  version?: string;
};

export const OtlpSpanKind = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;
export type OtlpSpanKind = (typeof OtlpSpanKind)[keyof typeof OtlpSpanKind];

export const OtlpStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;
export type OtlpStatusCode = (typeof OtlpStatusCode)[keyof typeof OtlpStatusCode];

// Subset of the OTEL log severity numbers we actually emit.
export const OtlpSeverityNumber = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
} as const;
export type OtlpSeverityNumber = (typeof OtlpSeverityNumber)[keyof typeof OtlpSeverityNumber];

export type OtlpSpanEvent = {
  timeUnixNano: string;
  name: string;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
};

export type OtlpSpanLink = {
  traceId: string;
  spanId: string;
  attributes?: OtlpKeyValue[];
};

export type OtlpStatus = {
  code: OtlpStatusCode;
  message?: string;
};

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: OtlpSpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  links?: OtlpSpanLink[];
  status?: OtlpStatus;
};

export type OtlpScopeSpans = {
  scope?: OtlpInstrumentationScope;
  spans: OtlpSpan[];
};

export type OtlpResourceSpans = {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
};

export type OtlpLogRecord = {
  timeUnixNano: string;
  observedTimeUnixNano?: string;
  severityNumber?: OtlpSeverityNumber;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
};

export type OtlpScopeLogs = {
  scope?: OtlpInstrumentationScope;
  logRecords: OtlpLogRecord[];
};

export type OtlpResourceLogs = {
  resource: OtlpResource;
  scopeLogs: OtlpScopeLogs[];
};

// One line of an `*.otlp.jsonl` stream. A line may carry spans, logs, or both.
// This is a Playwright archive envelope, not a single canonical OTLP export -
// see the design doc.
export type OtlpExportLine = {
  resourceSpans?: OtlpResourceSpans[];
  resourceLogs?: OtlpResourceLogs[];
};

// --- Playwright archive manifest --------------------------------------------

export type OtelTraceManifest = {
  // Discriminator the loader keys on to take the OTEL path.
  format: 'playwright-otel';
  formatVersion: number;
  playwrightVersion?: string;
};

export const kOtelManifestEntry = 'otel/manifest.json';
export const kOtelStreamSuffix = '.otlp.jsonl';
export const kOtelFormat = 'playwright-otel';
export const kOtelFormatVersion = 1;

// --- Playwright attribute / scope conventions -------------------------------

// Instrumentation scope all our records share.
export const kOtelScope: OtlpInstrumentationScope = {
  name: 'playwright',
};

// Standard OpenTelemetry semantic conventions we map onto directly. Where a fact
// has a real semconv home it lives here, so a vanilla OTEL backend (Tempo,
// Jaeger) renders errors, code locations, HTTP requests and producer identity
// without knowing anything about Playwright. The playwright.* namespaces below
// are only for concepts OTEL has no convention for - snapshots, screencasts, and
// the before/input/after replay phases. semconv is mid-migration on a few of
// these keys; we use the spellings current backends actually recognise.
export const SemAttr = {
  // Resource - producer identity.
  telemetrySdkName: 'telemetry.sdk.name',
  telemetrySdkVersion: 'telemetry.sdk.version',
  browserName: 'browser.name',
  // Span - code location of the call site (top stack frame).
  codeFilepath: 'code.filepath',
  codeFunction: 'code.function',
  codeLineno: 'code.lineno',
  codeColumn: 'code.column',
  // Span event - exception (the standard home for an action's error).
  exceptionType: 'exception.type',
  exceptionMessage: 'exception.message',
  exceptionStacktrace: 'exception.stacktrace',
  // Span - HTTP client request (network resource snapshots).
  httpRequestMethod: 'http.request.method',
  httpResponseStatusCode: 'http.response.status_code',
  urlFull: 'url.full',
} as const;

// Resource attributes (the emitting "entity" == a browser context).
export const PWResourceAttr = {
  contextId: 'playwright.context.id',
  origin: 'playwright.context.origin',
  // browserName -> standard `browser.name` (SemAttr.browserName).
  sdkLanguage: 'playwright.sdk.language',
  // Monotonic-to-epoch anchor for this context.
  anchorWallTimeMs: 'playwright.time.anchor.wall_ms',
  anchorMonotonicMs: 'playwright.time.anchor.monotonic_ms',
} as const;

// Span / log attributes.
//
// Two kinds of attribute live here. The first are genuinely OTEL-shaped facts
// (ids, the monotonic timestamps the viewer aligns on, page linkage). The
// second are Playwright-domain leaf payloads - params, results, console args,
// HAR entries, serialised errors - which OTLP can only carry as JSON strings
// because attribute values are scalars/arrays, never arbitrary nested objects.
// We give each its own named key rather than one mega-blob so the mapping stays
// legible: the span/log structure is OTEL, the leaves ride along namespaced.
export const PWAttr = {
  callId: 'playwright.call.id',
  stepId: 'playwright.step.id',
  parentId: 'playwright.parent.id',
  group: 'playwright.group.id',
  pageId: 'playwright.page.id',
  title: 'playwright.title',
  apiName: 'playwright.api.name',
  apiClass: 'playwright.api.class',
  apiMethod: 'playwright.api.method',
  apiParams: 'playwright.api.params',
  apiResult: 'playwright.api.result',
  // Raw monotonic times preserved for exact viewer ordering / delta alignment.
  // The span's start/endTimeUnixNano carry the real epoch time for OTEL
  // consumers; the viewer rebuilds its numbers from these instead.
  monotonicTimeMs: 'playwright.monotonic_time_ms',
  monotonicEndTimeMs: 'playwright.monotonic_end_time_ms',
  // Action leaf payloads. (error -> standard `exception` span event, see SemAttr.)
  result: 'playwright.result',
  attachments: 'playwright.attachments',
  annotations: 'playwright.annotations',
  stack: 'playwright.stack',
  point: 'playwright.point',
  beforeSnapshot: 'playwright.snapshot.before',
  inputSnapshot: 'playwright.snapshot.input',
  afterSnapshot: 'playwright.snapshot.after',
  message: 'playwright.message',
  // Browser event / console payloads.
  eventClass: 'playwright.event.class',
  eventMethod: 'playwright.event.method',
  eventParams: 'playwright.event.params',
  // messageType -> log severityText, text -> log body (the OTEL logs data model).
  consoleArgs: 'playwright.console.args',
  consoleLocation: 'playwright.console.location',
  // Stdio payloads.
  stdioText: 'playwright.stdio.text',
  stdioBase64: 'playwright.stdio.base64',
  // Screencast frame geometry.
  screencastWidth: 'playwright.screencast.width',
  screencastHeight: 'playwright.screencast.height',
  screencastFrameSwapWallTimeMs: 'playwright.screencast.frame_swap_wall_time_ms',
  // Network resource snapshot (HAR entry) carried losslessly as JSON.
  harEntry: 'playwright.har_entry',
  // Context-options payload (one log record per context, the reader's source of
  // truth for ContextEntry-level fields).
  ctxVersion: 'playwright.context.version',
  ctxChannel: 'playwright.context.channel',
  ctxPlatform: 'playwright.context.platform',
  // playwrightVersion -> standard `telemetry.sdk.version` on the resource.
  ctxTitle: 'playwright.context.title',
  ctxOptions: 'playwright.context.options',
  ctxTestIdAttributeName: 'playwright.context.test_id_attribute_name',
  ctxTestTimeout: 'playwright.context.test_timeout',
  ctxWallTimeMs: 'playwright.context.wall_time_ms',
  ctxMonotonicTimeMs: 'playwright.context.monotonic_time_ms',
  // External blob reference (content-addressed resources/<sha1>).
  blobSha1: 'playwright.blob.sha1',
  blobUri: 'playwright.blob.uri',
  blobMediaType: 'playwright.blob.media_type',
  blobSize: 'playwright.blob.size',
  // Log-record kinds.
  logKind: 'playwright.log.kind',
} as const;

// Names for span events and log records, mirroring the v8 event taxonomy.
export const PWSpanEvent = {
  before: 'playwright.action.before',
  input: 'playwright.action.input',
  after: 'playwright.action.after',
  log: 'playwright.action.log',
  snapshot: 'playwright.snapshot',
  attachment: 'playwright.attachment',
  exception: 'exception',
} as const;

export const PWLogKind = {
  contextOptions: 'playwright.context_options',
  browserEvent: 'playwright.browser_event',
  console: 'playwright.console',
  stdio: 'playwright.stdio',
  error: 'playwright.error',
  screencastFrame: 'playwright.screencast.frame',
  frameSnapshot: 'playwright.frame_snapshot',
} as const;

// --- AnyValue + attribute constructors --------------------------------------

export function stringValue(value: string): OtlpAnyValue {
  return { stringValue: value };
}

export function boolValue(value: boolean): OtlpAnyValue {
  return { boolValue: value };
}

export function intValue(value: number): OtlpAnyValue {
  return { intValue: String(Math.trunc(value)) };
}

export function doubleValue(value: number): OtlpAnyValue {
  return { doubleValue: value };
}

export function anyValue(value: unknown): OtlpAnyValue {
  if (typeof value === 'string')
    return stringValue(value);
  if (typeof value === 'boolean')
    return boolValue(value);
  if (typeof value === 'number')
    return Number.isInteger(value) ? intValue(value) : doubleValue(value);
  if (Array.isArray(value))
    return { arrayValue: { values: value.map(anyValue) } };
  if (value && typeof value === 'object')
    return { kvlistValue: { values: keyValues(value as Record<string, unknown>) } };
  // null / undefined / symbol / function: represent as an empty value.
  return {};
}

export function keyValue(key: string, value: OtlpAnyValue): OtlpKeyValue {
  return { key, value };
}

export function keyValues(record: Record<string, unknown>): OtlpKeyValue[] {
  const result: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined)
      continue;
    result.push(keyValue(key, anyValue(value)));
  }
  return result;
}

// Arbitrary nested JSON (params/result) is stored losslessly as a JSON string
// rather than a structured kvlist - see upfront decision 3 in the plan.
export function jsonValue(value: unknown): OtlpAnyValue {
  return stringValue(JSON.stringify(value ?? null));
}

export function blobAttributes(blob: { sha1: string, uri?: string, mediaType?: string, size?: number }): OtlpKeyValue[] {
  const result: OtlpKeyValue[] = [keyValue(PWAttr.blobSha1, stringValue(blob.sha1))];
  result.push(keyValue(PWAttr.blobUri, stringValue(blob.uri ?? `resources/${blob.sha1}`)));
  if (blob.mediaType !== undefined)
    result.push(keyValue(PWAttr.blobMediaType, stringValue(blob.mediaType)));
  if (blob.size !== undefined)
    result.push(keyValue(PWAttr.blobSize, intValue(blob.size)));
  return result;
}

// --- AnyValue + attribute readers (the inverse of the constructors) ---------

export function attributeMap(attributes: OtlpKeyValue[] | undefined): Map<string, OtlpAnyValue> {
  const map = new Map<string, OtlpAnyValue>();
  for (const { key, value } of attributes ?? [])
    map.set(key, value);
  return map;
}

export function readString(attrs: Map<string, OtlpAnyValue>, key: string): string | undefined {
  return attrs.get(key)?.stringValue;
}

export function readInt(attrs: Map<string, OtlpAnyValue>, key: string): number | undefined {
  const value = attrs.get(key);
  if (value?.intValue !== undefined)
    return Number(value.intValue);
  if (value?.doubleValue !== undefined)
    return value.doubleValue;
  return undefined;
}

export function readNumber(attrs: Map<string, OtlpAnyValue>, key: string): number | undefined {
  const value = attrs.get(key);
  if (value?.doubleValue !== undefined)
    return value.doubleValue;
  if (value?.intValue !== undefined)
    return Number(value.intValue);
  return undefined;
}

export function readBool(attrs: Map<string, OtlpAnyValue>, key: string): boolean | undefined {
  return attrs.get(key)?.boolValue;
}

// Inverse of jsonValue. Returns undefined for an absent attribute, the parsed
// value otherwise (including null).
export function readJson<T = unknown>(attrs: Map<string, OtlpAnyValue>, key: string): T | undefined {
  const raw = attrs.get(key)?.stringValue;
  if (raw === undefined)
    return undefined;
  const parsed = JSON.parse(raw);
  return parsed === null ? undefined : parsed as T;
}

// --- Time conversion --------------------------------------------------------

export type TimeAnchor = {
  // Epoch wall-clock and monotonic readings captured at the same instant
  // (both in milliseconds), as recorded in the context-options event.
  wallTimeMs: number;
  monotonicTimeMs: number;
};

// Playwright records everything in monotonic milliseconds; OTLP wants epoch
// nanoseconds. Re-anchor onto wall time, then scale to nanos. We keep the large
// integer wall anchor and the small monotonic delta separate: summing them into
// one double first would burn the sub-millisecond precision of the delta.
export function epochNanosFromMonotonic(monotonicMs: number, anchor: TimeAnchor): string {
  const deltaMs = monotonicMs - anchor.monotonicTimeMs;
  const wallWholeMs = Math.floor(anchor.wallTimeMs);
  const wallFractionMs = anchor.wallTimeMs - wallWholeMs;
  const nanos = BigInt(wallWholeMs) * 1_000_000n
    + BigInt(Math.round((wallFractionMs + deltaMs) * 1_000_000));
  return nanos.toString();
}

export function millisToNanoString(epochMs: number): string {
  // Avoid float precision loss at nanosecond scale: split whole millis from the
  // fractional part and assemble the integer string with BigInt.
  const wholeMs = Math.floor(epochMs);
  const fractionMs = epochMs - wholeMs;
  const nanos = BigInt(wholeMs) * 1_000_000n + BigInt(Math.round(fractionMs * 1_000_000));
  return nanos.toString();
}

// --- Deterministic id generation --------------------------------------------

// 64-bit FNV-1a over UTF-16 code units (good enough, fully synchronous and
// isomorphic). We only need stable, low-collision ids within a single trace.
const kFnvOffset = 0xcbf29ce484222325n;
const kFnvPrime = 0x00000100000001b3n;
const kMask64 = 0xffffffffffffffffn;

function fnv1a64(input: string): bigint {
  let hash = kFnvOffset;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * kFnvPrime) & kMask64;
  }
  return hash;
}

function hex(value: bigint, bytes: number): string {
  return value.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
}

// OTEL trace ids are 16 bytes; span ids are 8 bytes. Both must be non-zero hex.
export function traceIdFor(contextId: string): string {
  const hi = fnv1a64('otel-trace-hi:' + contextId);
  const lo = fnv1a64('otel-trace-lo:' + contextId);
  const id = hex(hi, 8) + hex(lo, 8);
  return id === '0'.repeat(32) ? '0'.repeat(31) + '1' : id;
}

export function spanIdFor(key: string): string {
  const id = hex(fnv1a64('otel-span:' + key), 8);
  return id === '0'.repeat(16) ? '0'.repeat(15) + '1' : id;
}

// --- Builder primitives -----------------------------------------------------

export function resource(attributes: OtlpKeyValue[]): OtlpResource {
  return { attributes };
}

export function resourceSpans(res: OtlpResource, spans: OtlpSpan[]): OtlpResourceSpans {
  return { resource: res, scopeSpans: [{ scope: kOtelScope, spans }] };
}

export function resourceLogs(res: OtlpResource, logRecords: OtlpLogRecord[]): OtlpResourceLogs {
  return { resource: res, scopeLogs: [{ scope: kOtelScope, logRecords }] };
}
