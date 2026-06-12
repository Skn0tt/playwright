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

// The two halves of the OTEL rebase, side by side:
//
//   - OtelTraceConverter: v8 trace event -> OTLP export line (writer side).
//   - OtelTraceReader:     OTLP export lines -> ContextEntry (reader side).
//
// The reader builds the viewer's ContextEntry *directly* from OTLP spans and
// log records - it does not reconstruct v8 events and feed the old modernizer.
// That is the whole point: prove the viewer model maps onto OTEL natively.
//
// Only otelTrace (same package, no imports) is a runtime dependency; everything
// else is type-only, so this file runs under `node --experimental-strip-types`
// against the standalone compat check.

import * as otel from './otelTrace';

import type * as trace from './trace';
import type { FrameSnapshot, ResourceSnapshot } from './snapshot';
import type { ActionEntry, ContextEntry, PageEntry } from '@isomorphic/trace/entries';

// --- Writer side ------------------------------------------------------------

// Snapshot of the timing/identity context the converter needs, learned from the
// context-options event.
type ConverterState = {
  traceId: string;
  contextId: string;
  origin: 'testRunner' | 'library';
  browserName: string;
  sdkLanguage?: string;
  playwrightVersion?: string;
  anchor: otel.TimeAnchor;
};

// Console message types bucket onto the standard log severity numbers; the raw
// type rides along in severityText, so it round-trips losslessly.
function consoleSeverity(messageType: string): otel.OtlpSeverityNumber {
  switch (messageType) {
    case 'error': return otel.OtlpSeverityNumber.ERROR;
    case 'warning': return otel.OtlpSeverityNumber.WARN;
    case 'debug': return otel.OtlpSeverityNumber.DEBUG;
    case 'trace': return otel.OtlpSeverityNumber.TRACE;
    default: return otel.OtlpSeverityNumber.INFO;
  }
}

export class OtelTraceConverter {
  private _state: ConverterState;

  constructor(contextId: string) {
    this._state = {
      traceId: otel.traceIdFor(contextId),
      contextId,
      origin: 'library',
      browserName: '',
      anchor: { wallTimeMs: 0, monotonicTimeMs: 0 },
    };
  }

  // Maps one v8 trace event onto one OTLP export line. Order is preserved by the
  // caller, which is what lets the reader replay merges/min-max faithfully.
  convert(event: trace.TraceEvent): otel.OtlpExportLine {
    switch (event.type) {
      case 'context-options':
        return this._contextOptions(event);
      case 'before':
        return this._before(event);
      case 'input':
        return this._input(event);
      case 'log':
        return this._log(event);
      case 'after':
        return this._after(event);
      case 'action':
        return this._action(event);
      case 'event':
        return this._browserEvent(event);
      case 'console':
        return this._console(event);
      case 'stdout':
      case 'stderr':
        return this._stdio(event);
      case 'error':
        return this._error(event);
      case 'screencast-frame':
        return this._screencast(event);
      case 'resource-snapshot':
        return this._resourceSnapshot(event);
      case 'frame-snapshot':
        return this._frameSnapshot(event);
    }
  }

  private _resource(): otel.OtlpResource {
    const s = this._state;
    const attrs = [
      otel.keyValue(otel.SemAttr.telemetrySdkName, otel.stringValue('playwright')),
      otel.keyValue(otel.SemAttr.browserName, otel.stringValue(s.browserName)),
      otel.keyValue(otel.PWResourceAttr.contextId, otel.stringValue(s.contextId)),
      otel.keyValue(otel.PWResourceAttr.origin, otel.stringValue(s.origin)),
      otel.keyValue(otel.PWResourceAttr.anchorWallTimeMs, otel.doubleValue(s.anchor.wallTimeMs)),
      otel.keyValue(otel.PWResourceAttr.anchorMonotonicMs, otel.doubleValue(s.anchor.monotonicTimeMs)),
    ];
    if (s.playwrightVersion !== undefined)
      attrs.push(otel.keyValue(otel.SemAttr.telemetrySdkVersion, otel.stringValue(s.playwrightVersion)));
    if (s.sdkLanguage !== undefined)
      attrs.push(otel.keyValue(otel.PWResourceAttr.sdkLanguage, otel.stringValue(s.sdkLanguage)));
    return otel.resource(attrs);
  }

  private _nanos(monotonicMs: number): string {
    return otel.epochNanosFromMonotonic(monotonicMs, this._state.anchor);
  }

  private _spanLine(span: otel.OtlpSpan): otel.OtlpExportLine {
    return { resourceSpans: [otel.resourceSpans(this._resource(), [span])] };
  }

  private _logLine(record: otel.OtlpLogRecord): otel.OtlpExportLine {
    return { resourceLogs: [otel.resourceLogs(this._resource(), [record])] };
  }

  private _logRecord(kind: string, monotonicMs: number, attributes: otel.OtlpKeyValue[], severity?: otel.OtlpSeverityNumber): otel.OtlpLogRecord {
    return {
      timeUnixNano: monotonicMs >= 0 ? this._nanos(monotonicMs) : '0',
      severityNumber: severity,
      attributes: [otel.keyValue(otel.PWAttr.logKind, otel.stringValue(kind)), ...attributes],
    };
  }

  private _contextOptions(event: trace.ContextCreatedTraceEvent): otel.OtlpExportLine {
    // Re-anchor and capture resource identity from the canonical first event.
    this._state.anchor = { wallTimeMs: event.wallTime, monotonicTimeMs: event.monotonicTime };
    this._state.origin = event.origin;
    this._state.browserName = event.browserName;
    this._state.sdkLanguage = event.sdkLanguage;
    this._state.playwrightVersion = event.playwrightVersion;
    if (event.contextId !== undefined)
      this._state.contextId = event.contextId;

    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.ctxVersion, otel.intValue(event.version)),
      otel.keyValue(otel.PWAttr.ctxWallTimeMs, otel.doubleValue(event.wallTime)),
      otel.keyValue(otel.PWAttr.ctxMonotonicTimeMs, otel.doubleValue(event.monotonicTime)),
      otel.keyValue(otel.PWAttr.ctxOptions, otel.jsonValue(event.options)),
    ];
    if (event.channel !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.ctxChannel, otel.stringValue(event.channel)));
    if (event.platform !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.ctxPlatform, otel.stringValue(event.platform)));
    if (event.title !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.ctxTitle, otel.stringValue(event.title)));
    if (event.testIdAttributeName !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.ctxTestIdAttributeName, otel.stringValue(event.testIdAttributeName)));
    if (event.testTimeout !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.ctxTestTimeout, otel.doubleValue(event.testTimeout)));
    return this._logLine(this._logRecord(otel.PWLogKind.contextOptions, event.monotonicTime, attrs));
  }

  private _actionIdentityAttrs(event: trace.BeforeActionTraceEvent | trace.ActionTraceEvent): otel.OtlpKeyValue[] {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.callId, otel.stringValue(event.callId)),
      otel.keyValue(otel.PWAttr.monotonicTimeMs, otel.doubleValue(event.startTime)),
      otel.keyValue(otel.PWAttr.apiClass, otel.stringValue(event.class)),
      otel.keyValue(otel.PWAttr.apiMethod, otel.stringValue(event.method)),
      otel.keyValue(otel.PWAttr.apiParams, otel.jsonValue(event.params)),
    ];
    if (event.title !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.title, otel.stringValue(event.title)));
    if (event.stepId !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.stepId, otel.stringValue(event.stepId)));
    if (event.parentId !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.parentId, otel.stringValue(event.parentId)));
    if (event.group !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.group, otel.stringValue(event.group)));
    if (event.pageId !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.pageId, otel.stringValue(event.pageId)));
    if (event.beforeSnapshot !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.beforeSnapshot, otel.stringValue(event.beforeSnapshot)));
    if (event.stack !== undefined) {
      // Full stack stays custom (replay needs every frame); the top frame also
      // populates standard code.* so the span has a recognisable origin.
      attrs.push(otel.keyValue(otel.PWAttr.stack, otel.jsonValue(event.stack)));
      const top = event.stack[0];
      if (top) {
        attrs.push(otel.keyValue(otel.SemAttr.codeFilepath, otel.stringValue(top.file)));
        attrs.push(otel.keyValue(otel.SemAttr.codeLineno, otel.intValue(top.line)));
        attrs.push(otel.keyValue(otel.SemAttr.codeColumn, otel.intValue(top.column)));
        if (top.function !== undefined)
          attrs.push(otel.keyValue(otel.SemAttr.codeFunction, otel.stringValue(top.function)));
      }
    }
    return attrs;
  }

  private _before(event: trace.BeforeActionTraceEvent): otel.OtlpExportLine {
    const span: otel.OtlpSpan = {
      traceId: this._state.traceId,
      spanId: otel.spanIdFor(event.callId),
      parentSpanId: event.parentId !== undefined ? otel.spanIdFor(event.parentId) : undefined,
      name: event.title || `${event.class}.${event.method}`,
      kind: otel.OtlpSpanKind.INTERNAL,
      startTimeUnixNano: this._nanos(event.startTime),
      endTimeUnixNano: '0',
      attributes: this._actionIdentityAttrs(event),
    };
    return this._spanLine(span);
  }

  private _partialSpan(callId: string, attributes: otel.OtlpKeyValue[], extras?: Partial<otel.OtlpSpan>): otel.OtlpSpan {
    return {
      traceId: this._state.traceId,
      spanId: otel.spanIdFor(callId),
      name: '',
      kind: otel.OtlpSpanKind.INTERNAL,
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      attributes,
      ...extras,
    };
  }

  private _input(event: trace.InputActionTraceEvent): otel.OtlpExportLine {
    const attrs: otel.OtlpKeyValue[] = [];
    if (event.inputSnapshot !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.inputSnapshot, otel.stringValue(event.inputSnapshot)));
    if (event.point !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.point, otel.jsonValue(event.point)));
    return this._spanLine(this._partialSpan(event.callId, attrs));
  }

  private _log(event: trace.LogTraceEvent): otel.OtlpExportLine {
    const span = this._partialSpan(event.callId, [], {
      events: [{
        name: otel.PWSpanEvent.log,
        timeUnixNano: event.time >= 0 ? this._nanos(event.time) : '0',
        attributes: [
          otel.keyValue(otel.PWAttr.monotonicTimeMs, otel.doubleValue(event.time)),
          otel.keyValue(otel.PWAttr.message, otel.stringValue(event.message)),
        ],
      }],
    });
    return this._spanLine(span);
  }

  private _afterAttrs(event: trace.AfterActionTraceEvent): otel.OtlpKeyValue[] {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.monotonicEndTimeMs, otel.doubleValue(event.endTime)),
    ];
    if (event.afterSnapshot !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.afterSnapshot, otel.stringValue(event.afterSnapshot)));
    if (event.result !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.result, otel.jsonValue(event.result)));
    if (event.attachments !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.attachments, otel.jsonValue(event.attachments)));
    if (event.annotations !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.annotations, otel.jsonValue(event.annotations)));
    if (event.point !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.point, otel.jsonValue(event.point)));
    return attrs;
  }

  // The standard OTEL exception event. An action's error is always
  // {name, message, stack?}, which maps onto exception.* losslessly - no need to
  // keep a custom copy.
  private _exceptionEvent(error: NonNullable<trace.AfterActionTraceEvent['error']>, monotonicMs: number): otel.OtlpSpanEvent {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.SemAttr.exceptionType, otel.stringValue(error.name)),
      otel.keyValue(otel.SemAttr.exceptionMessage, otel.stringValue(error.message)),
    ];
    if (error.stack !== undefined)
      attrs.push(otel.keyValue(otel.SemAttr.exceptionStacktrace, otel.stringValue(error.stack)));
    return {
      name: otel.PWSpanEvent.exception,
      timeUnixNano: monotonicMs >= 0 ? this._nanos(monotonicMs) : '0',
      attributes: attrs,
    };
  }

  private _after(event: trace.AfterActionTraceEvent): otel.OtlpExportLine {
    const span = this._partialSpan(event.callId, this._afterAttrs(event), {
      endTimeUnixNano: this._nanos(event.endTime),
      status: event.error ? { code: otel.OtlpStatusCode.ERROR, message: event.error.message } : undefined,
      events: event.error ? [this._exceptionEvent(event.error, event.endTime)] : undefined,
    });
    return this._spanLine(span);
  }

  // A pre-merged action (only seen on modernized old traces). Emit a complete span.
  private _action(event: trace.ActionTraceEvent): otel.OtlpExportLine {
    const attrs = [...this._actionIdentityAttrs(event), ...this._afterAttrs({ ...event, type: 'after' })];
    if (event.inputSnapshot !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.inputSnapshot, otel.stringValue(event.inputSnapshot)));
    const span: otel.OtlpSpan = {
      traceId: this._state.traceId,
      spanId: otel.spanIdFor(event.callId),
      parentSpanId: event.parentId !== undefined ? otel.spanIdFor(event.parentId) : undefined,
      name: event.title || `${event.class}.${event.method}`,
      kind: otel.OtlpSpanKind.INTERNAL,
      startTimeUnixNano: this._nanos(event.startTime),
      endTimeUnixNano: this._nanos(event.endTime),
      attributes: attrs,
      status: event.error ? { code: otel.OtlpStatusCode.ERROR, message: event.error.message } : undefined,
      events: event.error ? [this._exceptionEvent(event.error, event.endTime)] : undefined,
    };
    return this._spanLine(span);
  }

  private _browserEvent(event: trace.EventTraceEvent): otel.OtlpExportLine {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.monotonicTimeMs, otel.doubleValue(event.time)),
      otel.keyValue(otel.PWAttr.eventClass, otel.stringValue(event.class)),
      otel.keyValue(otel.PWAttr.eventMethod, otel.stringValue(event.method)),
      otel.keyValue(otel.PWAttr.eventParams, otel.jsonValue(event.params)),
    ];
    if (event.pageId !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.pageId, otel.stringValue(event.pageId)));
    return this._logLine(this._logRecord(otel.PWLogKind.browserEvent, event.time, attrs));
  }

  private _console(event: trace.ConsoleMessageTraceEvent): otel.OtlpExportLine {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.monotonicTimeMs, otel.doubleValue(event.time)),
      otel.keyValue(otel.PWAttr.consoleLocation, otel.jsonValue(event.location)),
    ];
    if (event.pageId !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.pageId, otel.stringValue(event.pageId)));
    if (event.args !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.consoleArgs, otel.jsonValue(event.args)));
    // text -> log body, messageType -> severityText: exactly what the OTEL logs
    // data model means by body/severity.
    const record = this._logRecord(otel.PWLogKind.console, event.time, attrs, consoleSeverity(event.messageType));
    record.body = otel.stringValue(event.text);
    record.severityText = event.messageType;
    return this._logLine(record);
  }

  private _stdio(event: trace.StdioTraceEvent): otel.OtlpExportLine {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.monotonicTimeMs, otel.doubleValue(event.timestamp)),
      otel.keyValue('playwright.stdio.stream', otel.stringValue(event.type)),
    ];
    if (event.text !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.stdioText, otel.stringValue(event.text)));
    if (event.base64 !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.stdioBase64, otel.stringValue(event.base64)));
    const severity = event.type === 'stderr' ? otel.OtlpSeverityNumber.ERROR : otel.OtlpSeverityNumber.INFO;
    return this._logLine(this._logRecord(otel.PWLogKind.stdio, event.timestamp, attrs, severity));
  }

  private _error(event: trace.ErrorTraceEvent): otel.OtlpExportLine {
    const attrs: otel.OtlpKeyValue[] = [];
    if (event.stack !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.stack, otel.jsonValue(event.stack)));
    // message -> log body, the standard home for a log record's text.
    const record = this._logRecord(otel.PWLogKind.error, -1, attrs, otel.OtlpSeverityNumber.ERROR);
    record.body = otel.stringValue(event.message);
    return this._logLine(record);
  }

  private _screencast(event: trace.ScreencastFrameTraceEvent): otel.OtlpExportLine {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.pageId, otel.stringValue(event.pageId)),
      otel.keyValue(otel.PWAttr.monotonicTimeMs, otel.doubleValue(event.timestamp)),
      otel.keyValue(otel.PWAttr.screencastWidth, otel.intValue(event.width)),
      otel.keyValue(otel.PWAttr.screencastHeight, otel.intValue(event.height)),
      ...otel.blobAttributes({ sha1: event.sha1, mediaType: 'image/jpeg' }),
    ];
    if (event.frameSwapWallTime !== undefined)
      attrs.push(otel.keyValue(otel.PWAttr.screencastFrameSwapWallTimeMs, otel.doubleValue(event.frameSwapWallTime)));
    return this._logLine(this._logRecord(otel.PWLogKind.screencastFrame, event.timestamp, attrs));
  }

  // Network entries are real client-side operations - a natural fit for a
  // CLIENT span. The HAR entry itself rides along as a JSON attribute.
  private _resourceSnapshot(event: trace.ResourceSnapshotTraceEvent): otel.OtlpExportLine {
    const snapshot = event.snapshot;
    const monotonic = snapshot._monotonicTime ?? 0;
    const span: otel.OtlpSpan = {
      traceId: this._state.traceId,
      spanId: otel.spanIdFor(`resource:${snapshot.request.url}:${monotonic}`),
      name: `${snapshot.request.method} ${snapshot.request.url}`,
      kind: otel.OtlpSpanKind.CLIENT,
      startTimeUnixNano: monotonic >= 0 ? this._nanos(monotonic) : '0',
      endTimeUnixNano: monotonic >= 0 ? this._nanos(monotonic) : '0',
      attributes: [
        otel.keyValue(otel.PWAttr.monotonicTimeMs, otel.doubleValue(monotonic)),
        // Standard HTTP client attributes so the span renders as a request in any
        // OTEL backend; the full HAR entry rides along for replay fidelity.
        otel.keyValue(otel.SemAttr.httpRequestMethod, otel.stringValue(snapshot.request.method)),
        otel.keyValue(otel.SemAttr.httpResponseStatusCode, otel.intValue(snapshot.response.status)),
        otel.keyValue(otel.SemAttr.urlFull, otel.stringValue(snapshot.request.url)),
        otel.keyValue(otel.PWAttr.harEntry, otel.jsonValue(snapshot)),
      ],
    };
    return this._spanLine(span);
  }

  private _frameSnapshot(event: trace.FrameSnapshotTraceEvent): otel.OtlpExportLine {
    const attrs: otel.OtlpKeyValue[] = [
      otel.keyValue(otel.PWAttr.pageId, otel.stringValue(event.snapshot.pageId)),
      otel.keyValue(otel.PWAttr.harEntry, otel.jsonValue(event.snapshot)),
    ];
    return this._logLine(this._logRecord(otel.PWLogKind.frameSnapshot, event.snapshot.timestamp, attrs));
  }
}

// Convenience for callers that just want the serialised JSONL line.
export function traceEventToOtlpLine(converter: OtelTraceConverter, event: trace.TraceEvent): string {
  return JSON.stringify(converter.convert(event));
}

// --- Reader side ------------------------------------------------------------

export interface SnapshotSink {
  addResource(contextId: string, resource: ResourceSnapshot): void;
  addFrameSnapshot(contextId: string, snapshot: FrameSnapshot, screencastFrames: PageEntry['screencastFrames']): void;
}

const latestVersion = 8;

export class OtelTraceVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtelTraceVersionError';
  }
}

// Builds a ContextEntry directly from OTLP records, mirroring the assembly the
// modernizer does from v8 events (TraceModernizer._innerAppendEvent). Drop-in
// for TraceModernizer in the loader: same appendTrace/actions surface.
export class OtelTraceReader {
  private _contextEntry: ContextEntry;
  private _snapshotSink: SnapshotSink;
  private _actionMap = new Map<string, ActionEntry>();
  private _pageEntries = new Map<string, PageEntry>();
  private _resourceAttrs = new Map<string, otel.OtlpAnyValue>();
  private _version: number | undefined;

  constructor(contextEntry: ContextEntry, snapshotSink: SnapshotSink) {
    this._contextEntry = contextEntry;
    this._snapshotSink = snapshotSink;
  }

  appendTrace(text: string) {
    for (const line of text.split('\n'))
      this.appendLine(line);
  }

  appendLine(line: string) {
    if (!line)
      return;
    this.appendExport(JSON.parse(line) as otel.OtlpExportLine);
  }

  appendExport(line: otel.OtlpExportLine) {
    for (const resourceSpans of line.resourceSpans ?? []) {
      this._captureResource(resourceSpans.resource);
      for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
        for (const span of scopeSpans.spans ?? [])
          this._appendSpan(span);
      }
    }
    for (const resourceLogs of line.resourceLogs ?? []) {
      this._captureResource(resourceLogs.resource);
      for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
        for (const record of scopeLogs.logRecords ?? [])
          this._appendLogRecord(record);
      }
    }
  }

  // Resource attributes are the OTEL-native home for producer identity
  // (origin/browserName/sdkLanguage). The converter stamps the same resource on
  // every line, so we keep the latest view here for _contextOptions to read.
  private _captureResource(resource: otel.OtlpResource | undefined) {
    if (!resource)
      return;
    for (const [key, value] of otel.attributeMap(resource.attributes))
      this._resourceAttrs.set(key, value);
  }

  actions(): ActionEntry[] {
    return [...this._actionMap.values()];
  }

  private _pageEntry(pageId: string): PageEntry {
    let pageEntry = this._pageEntries.get(pageId);
    if (!pageEntry) {
      pageEntry = { pageId, screencastFrames: [] };
      this._pageEntries.set(pageId, pageEntry);
      this._contextEntry.pages.push(pageEntry);
    }
    return pageEntry;
  }

  private _bumpStart(time: number) {
    this._contextEntry.startTime = Math.min(this._contextEntry.startTime, time);
  }

  private _bumpEnd(time: number) {
    this._contextEntry.endTime = Math.max(this._contextEntry.endTime, time);
  }

  private _appendSpan(span: otel.OtlpSpan) {
    const attrs = otel.attributeMap(span.attributes);
    // Network resource snapshots are CLIENT spans carrying a HAR entry.
    const harEntry = otel.readJson<ResourceSnapshot>(attrs, otel.PWAttr.harEntry);
    if (harEntry) {
      this._snapshotSink.addResource(this._contextEntry.contextId, harEntry);
      this._contextEntry.resources.push(harEntry);
      return;
    }

    const callId = otel.readString(attrs, otel.PWAttr.callId);
    let action = this._actionByCallId(span.spanId);

    // The before/action line is the only one carrying identity. Create here.
    if (callId !== undefined && !action) {
      action = {
        type: 'action',
        callId,
        startTime: otel.readNumber(attrs, otel.PWAttr.monotonicTimeMs) ?? 0,
        endTime: 0,
        class: otel.readString(attrs, otel.PWAttr.apiClass) ?? '',
        method: otel.readString(attrs, otel.PWAttr.apiMethod) ?? '',
        params: otel.readJson(attrs, otel.PWAttr.apiParams) ?? {},
        log: [],
      };
      const title = otel.readString(attrs, otel.PWAttr.title);
      if (title !== undefined)
        action.title = title;
      const stepId = otel.readString(attrs, otel.PWAttr.stepId);
      if (stepId !== undefined)
        action.stepId = stepId;
      const parentId = otel.readString(attrs, otel.PWAttr.parentId);
      if (parentId !== undefined)
        action.parentId = parentId;
      const group = otel.readString(attrs, otel.PWAttr.group);
      if (group !== undefined)
        action.group = group;
      const pageId = otel.readString(attrs, otel.PWAttr.pageId);
      if (pageId !== undefined)
        action.pageId = pageId;
      const beforeSnapshot = otel.readString(attrs, otel.PWAttr.beforeSnapshot);
      if (beforeSnapshot !== undefined)
        action.beforeSnapshot = beforeSnapshot;
      const stack = otel.readJson<trace.BeforeActionTraceEvent['stack']>(attrs, otel.PWAttr.stack);
      if (stack !== undefined)
        action.stack = stack;
      this._actionMap.set(span.spanId, action);
      this._bumpStart(action.startTime);
      if (action.pageId)
        this._pageEntry(action.pageId);
    }

    if (!action)
      return;

    // Merge whatever this line carries (input/log/after deltas, or the
    // pre-merged action's after fields).
    const inputSnapshot = otel.readString(attrs, otel.PWAttr.inputSnapshot);
    if (inputSnapshot !== undefined)
      action.inputSnapshot = inputSnapshot;
    const afterSnapshot = otel.readString(attrs, otel.PWAttr.afterSnapshot);
    if (afterSnapshot !== undefined)
      action.afterSnapshot = afterSnapshot;
    const point = otel.readJson<trace.AfterActionTraceEvent['point']>(attrs, otel.PWAttr.point);
    if (point !== undefined)
      action.point = point;
    const result = otel.readJson(attrs, otel.PWAttr.result);
    if (result !== undefined)
      action.result = result;
    const attachments = otel.readJson<trace.AfterActionTraceEvent['attachments']>(attrs, otel.PWAttr.attachments);
    if (attachments !== undefined)
      action.attachments = attachments;
    const annotations = otel.readJson<trace.AfterActionTraceEvent['annotations']>(attrs, otel.PWAttr.annotations);
    if (annotations !== undefined)
      action.annotations = annotations;
    const endTime = otel.readNumber(attrs, otel.PWAttr.monotonicEndTimeMs);
    if (endTime !== undefined) {
      action.endTime = endTime;
      this._bumpEnd(endTime);
    }

    // Span events fold back: log -> action.log, exception -> action.error.
    for (const spanEvent of span.events ?? []) {
      const eventAttrs = otel.attributeMap(spanEvent.attributes);
      if (spanEvent.name === otel.PWSpanEvent.log) {
        action.log.push({
          time: otel.readNumber(eventAttrs, otel.PWAttr.monotonicTimeMs) ?? -1,
          message: otel.readString(eventAttrs, otel.PWAttr.message) ?? '',
        });
      } else if (spanEvent.name === otel.PWSpanEvent.exception) {
        const error: NonNullable<trace.AfterActionTraceEvent['error']> = {
          name: otel.readString(eventAttrs, otel.SemAttr.exceptionType) ?? '',
          message: otel.readString(eventAttrs, otel.SemAttr.exceptionMessage) ?? '',
        };
        const stack = otel.readString(eventAttrs, otel.SemAttr.exceptionStacktrace);
        if (stack !== undefined)
          error.stack = stack;
        action.error = error;
      }
    }
  }

  private _actionByCallId(spanId: string): ActionEntry | undefined {
    return this._actionMap.get(spanId);
  }

  private _appendLogRecord(record: otel.OtlpLogRecord) {
    const attrs = otel.attributeMap(record.attributes);
    const kind = otel.readString(attrs, otel.PWAttr.logKind);
    switch (kind) {
      case otel.PWLogKind.contextOptions:
        this._contextOptions(attrs);
        break;
      case otel.PWLogKind.screencastFrame:
        this._screencast(attrs);
        break;
      case otel.PWLogKind.browserEvent:
        this._browserEvent(attrs);
        break;
      case otel.PWLogKind.console:
        this._console(attrs, record);
        break;
      case otel.PWLogKind.stdio:
        this._stdio(attrs);
        break;
      case otel.PWLogKind.error:
        this._error(attrs, record);
        break;
      case otel.PWLogKind.frameSnapshot:
        this._frameSnapshot(attrs);
        break;
    }
  }

  private _contextOptions(attrs: Map<string, otel.OtlpAnyValue>) {
    const contextEntry = this._contextEntry;
    const version = otel.readInt(attrs, otel.PWAttr.ctxVersion) ?? latestVersion;
    if (version > latestVersion)
      throw new OtelTraceVersionError('The trace was created by a newer version of Playwright and is not supported by this version of the viewer. Please use latest Playwright to open the trace.');
    this._version = version;
    contextEntry.origin = (otel.readString(this._resourceAttrs, otel.PWResourceAttr.origin) as ContextEntry['origin']) ?? contextEntry.origin;
    contextEntry.browserName = otel.readString(this._resourceAttrs, otel.SemAttr.browserName) ?? contextEntry.browserName;
    contextEntry.channel = otel.readString(attrs, otel.PWAttr.ctxChannel);
    contextEntry.title = otel.readString(attrs, otel.PWAttr.ctxTitle);
    contextEntry.platform = otel.readString(attrs, otel.PWAttr.ctxPlatform);
    contextEntry.playwrightVersion = otel.readString(this._resourceAttrs, otel.SemAttr.telemetrySdkVersion);
    contextEntry.wallTime = otel.readNumber(attrs, otel.PWAttr.ctxWallTimeMs) ?? 0;
    contextEntry.startTime = otel.readNumber(attrs, otel.PWAttr.ctxMonotonicTimeMs) ?? 0;
    contextEntry.sdkLanguage = otel.readString(this._resourceAttrs, otel.PWResourceAttr.sdkLanguage) as ContextEntry['sdkLanguage'];
    contextEntry.options = otel.readJson(attrs, otel.PWAttr.ctxOptions) ?? {};
    contextEntry.testIdAttributeName = otel.readString(attrs, otel.PWAttr.ctxTestIdAttributeName);
    contextEntry.testTimeout = otel.readNumber(attrs, otel.PWAttr.ctxTestTimeout);
  }

  // Browser-side protocol event -> contextEntry.events. Mirrors the 'event'
  // case in the modernizer, including the start/end bump and the page guarantee.
  private _browserEvent(attrs: Map<string, otel.OtlpAnyValue>) {
    const event: trace.EventTraceEvent = {
      type: 'event',
      time: otel.readNumber(attrs, otel.PWAttr.monotonicTimeMs) ?? 0,
      class: otel.readString(attrs, otel.PWAttr.eventClass) ?? '',
      method: otel.readString(attrs, otel.PWAttr.eventMethod) ?? '',
      params: otel.readJson(attrs, otel.PWAttr.eventParams),
    };
    const pageId = otel.readString(attrs, otel.PWAttr.pageId);
    if (pageId !== undefined)
      event.pageId = pageId;
    this._contextEntry.events.push(event);
    this._bumpStart(event.time);
    this._bumpEnd(event.time);
    if (event.pageId)
      this._pageEntry(event.pageId);
  }

  // Console message -> contextEntry.events. The modernizer does not move the
  // context start/end for console, only the page guarantee applies.
  private _console(attrs: Map<string, otel.OtlpAnyValue>, record: otel.OtlpLogRecord) {
    const event: trace.ConsoleMessageTraceEvent = {
      type: 'console',
      time: otel.readNumber(attrs, otel.PWAttr.monotonicTimeMs) ?? 0,
      messageType: record.severityText ?? '',
      text: record.body?.stringValue ?? '',
      location: otel.readJson<trace.ConsoleMessageTraceEvent['location']>(attrs, otel.PWAttr.consoleLocation) ?? { url: '', lineNumber: 0, columnNumber: 0 },
    };
    const pageId = otel.readString(attrs, otel.PWAttr.pageId);
    if (pageId !== undefined)
      event.pageId = pageId;
    const args = otel.readJson<trace.ConsoleMessageTraceEvent['args']>(attrs, otel.PWAttr.consoleArgs);
    if (args !== undefined)
      event.args = args;
    this._contextEntry.events.push(event);
    if (event.pageId)
      this._pageEntry(event.pageId);
  }

  private _stdio(attrs: Map<string, otel.OtlpAnyValue>) {
    const event: trace.StdioTraceEvent = {
      type: (otel.readString(attrs, 'playwright.stdio.stream') as trace.StdioTraceEvent['type']) ?? 'stdout',
      timestamp: otel.readNumber(attrs, otel.PWAttr.monotonicTimeMs) ?? 0,
    };
    const text = otel.readString(attrs, otel.PWAttr.stdioText);
    if (text !== undefined)
      event.text = text;
    const base64 = otel.readString(attrs, otel.PWAttr.stdioBase64);
    if (base64 !== undefined)
      event.base64 = base64;
    this._contextEntry.stdio.push(event);
  }

  private _error(attrs: Map<string, otel.OtlpAnyValue>, record: otel.OtlpLogRecord) {
    const event: trace.ErrorTraceEvent = {
      type: 'error',
      message: record.body?.stringValue ?? '',
    };
    const stack = otel.readJson<trace.ErrorTraceEvent['stack']>(attrs, otel.PWAttr.stack);
    if (stack !== undefined)
      event.stack = stack;
    this._contextEntry.errors.push(event);
  }

  // Screencast frame -> the page's screencastFrames. We rebuild the exact v8
  // event object (incl. type/pageId) the modernizer pushed, so the viewer model
  // is byte-for-byte identical.
  private _screencast(attrs: Map<string, otel.OtlpAnyValue>) {
    const pageId = otel.readString(attrs, otel.PWAttr.pageId) ?? '';
    const timestamp = otel.readNumber(attrs, otel.PWAttr.monotonicTimeMs) ?? 0;
    const frame: trace.ScreencastFrameTraceEvent = {
      type: 'screencast-frame',
      pageId,
      sha1: otel.readString(attrs, otel.PWAttr.blobSha1) ?? '',
      width: otel.readInt(attrs, otel.PWAttr.screencastWidth) ?? 0,
      height: otel.readInt(attrs, otel.PWAttr.screencastHeight) ?? 0,
      timestamp,
    };
    const frameSwapWallTime = otel.readNumber(attrs, otel.PWAttr.screencastFrameSwapWallTimeMs);
    if (frameSwapWallTime !== undefined)
      frame.frameSwapWallTime = frameSwapWallTime;
    this._pageEntry(pageId).screencastFrames.push(frame);
    this._bumpStart(timestamp);
    this._bumpEnd(timestamp);
  }

  private _frameSnapshot(attrs: Map<string, otel.OtlpAnyValue>) {
    const snapshot = otel.readJson<FrameSnapshot>(attrs, otel.PWAttr.harEntry);
    if (!snapshot)
      return;
    this._snapshotSink.addFrameSnapshot(this._contextEntry.contextId, snapshot, this._pageEntry(snapshot.pageId).screencastFrames);
  }
}
