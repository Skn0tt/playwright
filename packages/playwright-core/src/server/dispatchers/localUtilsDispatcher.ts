/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type * as channels from '@protocol/channels';
import { ManualPromise } from '../../utils/manualPromise';
import { assert, calculateSha1, createGuid, HttpServer, removeFolders, urlMatches } from '../../utils';
import type { RootDispatcher } from './dispatcher';
import { Dispatcher } from './dispatcher';
import { yazl, yauzl } from '../../zipBundle';
import { ZipFile } from '../../utils/zipFile';
import type * as har from '@trace/har';
import type { HeadersArray, NormalizedContinueOverrides, NormalizedFulfillResponse } from '../types';
import { JsonPipeDispatcher } from '../dispatchers/jsonPipeDispatcher';
import { WebSocketTransport } from '../transport';
import { SocksInterceptor } from '../socksInterceptor';
import type { CallMetadata } from '../instrumentation';
import { getUserAgent } from '../../utils/userAgent';
import type { Progress } from '../progress';
import { ProgressController } from '../progress';
import { fetchData } from '../../utils/network';
import type { HTTPRequestParams } from '../../utils/network';
import http from 'http';
import https from 'https';
import type { Playwright } from '../playwright';
import { SdkObject } from '../../server/instrumentation';
import { serializeClientSideCallMetadata } from '../../utils';
import { deviceDescriptors as descriptors }  from '../deviceDescriptors';
import type { ResourceTiming } from '../network';
import { Request, Response, Route } from '../network';
import { RequestDispatcher, ResponseDispatcher, RouteDispatcher } from './networkDispatchers';
import type { BrowserContext } from '../browserContext';
import url from 'url';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

export class LocalUtilsDispatcher extends Dispatcher<{ guid: string }, channels.LocalUtilsChannel, RootDispatcher> implements channels.LocalUtilsChannel {
  _type_LocalUtils: boolean;
  _type_EventTarget: boolean;
  private _harBackends = new Map<string, HarBackend>();
  private _stackSessions = new Map<string, {
    file: string,
    writer: Promise<void>,
    tmpDir: string | undefined,
    callStacks: channels.ClientSideCallMetadata[]
  }>();
  private _interceptionRegistry?: ServerInterceptionRegistry;

  constructor(scope: RootDispatcher, playwright: Playwright) {
    const localUtils = new SdkObject(playwright, 'localUtils', 'localUtils');
    const deviceDescriptors = Object.entries(descriptors)
        .map(([name, descriptor]) => ({ name, descriptor }));
    super(scope, localUtils, 'LocalUtils', {
      deviceDescriptors,
    });
    this._type_LocalUtils = true;
    this._type_EventTarget = true;
  }

  async zip(params: channels.LocalUtilsZipParams): Promise<void> {
    const promise = new ManualPromise<void>();
    const zipFile = new yazl.ZipFile();
    (zipFile as any as EventEmitter).on('error', error => promise.reject(error));

    const addFile = (file: string, name: string) => {
      try {
        if (fs.statSync(file).isFile())
          zipFile.addFile(file, name);
      } catch (e) {
      }
    };

    for (const entry of params.entries)
      addFile(entry.value, entry.name);

    // Add stacks and the sources.
    const stackSession = params.stacksId ? this._stackSessions.get(params.stacksId) : undefined;
    if (stackSession?.callStacks.length) {
      await stackSession.writer;
      if (process.env.PW_LIVE_TRACE_STACKS) {
        zipFile.addFile(stackSession.file, 'trace.stacks');
      } else {
        const buffer = Buffer.from(JSON.stringify(serializeClientSideCallMetadata(stackSession.callStacks)));
        zipFile.addBuffer(buffer, 'trace.stacks');
      }
    }

    // Collect sources from stacks.
    if (params.includeSources) {
      const sourceFiles = new Set<string>();
      for (const { stack } of stackSession?.callStacks || []) {
        if (!stack)
          continue;
        for (const { file } of stack)
          sourceFiles.add(file);
      }
      for (const sourceFile of sourceFiles)
        addFile(sourceFile, 'resources/src@' + calculateSha1(sourceFile) + '.txt');
    }

    if (params.mode === 'write') {
      // New file, just compress the entries.
      await fs.promises.mkdir(path.dirname(params.zipFile), { recursive: true });
      zipFile.end(undefined, () => {
        zipFile.outputStream.pipe(fs.createWriteStream(params.zipFile))
            .on('close', () => promise.resolve())
            .on('error', error => promise.reject(error));
      });
      await promise;
      await this._deleteStackSession(params.stacksId);
      return;
    }

    // File already exists. Repack and add new entries.
    const tempFile = params.zipFile + '.tmp';
    await fs.promises.rename(params.zipFile, tempFile);

    yauzl.open(tempFile, (err, inZipFile) => {
      if (err) {
        promise.reject(err);
        return;
      }
      assert(inZipFile);
      let pendingEntries = inZipFile.entryCount;
      inZipFile.on('entry', entry => {
        inZipFile.openReadStream(entry, (err, readStream) => {
          if (err) {
            promise.reject(err);
            return;
          }
          zipFile.addReadStream(readStream!, entry.fileName);
          if (--pendingEntries === 0) {
            zipFile.end(undefined, () => {
              zipFile.outputStream.pipe(fs.createWriteStream(params.zipFile)).on('close', () => {
                fs.promises.unlink(tempFile).then(() => {
                  promise.resolve();
                }).catch(error => promise.reject(error));
              });
            });
          }
        });
      });
    });
    await promise;
    await this._deleteStackSession(params.stacksId);
  }

  async harOpen(params: channels.LocalUtilsHarOpenParams, metadata: CallMetadata): Promise<channels.LocalUtilsHarOpenResult> {
    let harBackend: HarBackend;
    if (params.file.endsWith('.zip')) {
      const zipFile = new ZipFile(params.file);
      const entryNames = await zipFile.entries();
      const harEntryName = entryNames.find(e => e.endsWith('.har'));
      if (!harEntryName)
        return { error: 'Specified archive does not have a .har file' };
      const har = await zipFile.read(harEntryName);
      const harFile = JSON.parse(har.toString()) as har.HARFile;
      harBackend = new HarBackend(harFile, null, zipFile);
    } else {
      const harFile = JSON.parse(await fs.promises.readFile(params.file, 'utf-8')) as har.HARFile;
      harBackend = new HarBackend(harFile, path.dirname(params.file), null);
    }
    this._harBackends.set(harBackend.id, harBackend);
    return { harId: harBackend.id };
  }

  async harLookup(params: channels.LocalUtilsHarLookupParams, metadata: CallMetadata): Promise<channels.LocalUtilsHarLookupResult> {
    const harBackend = this._harBackends.get(params.harId);
    if (!harBackend)
      return { action: 'error', message: `Internal error: har was not opened` };
    return await harBackend.lookup(params.url, params.method, params.headers, params.postData, params.isNavigationRequest);
  }

  async harClose(params: channels.LocalUtilsHarCloseParams, metadata: CallMetadata): Promise<void> {
    const harBackend = this._harBackends.get(params.harId);
    if (harBackend) {
      this._harBackends.delete(harBackend.id);
      harBackend.dispose();
    }
  }

  async harUnzip(params: channels.LocalUtilsHarUnzipParams, metadata: CallMetadata): Promise<void> {
    const dir = path.dirname(params.zipFile);
    const zipFile = new ZipFile(params.zipFile);
    for (const entry of await zipFile.entries()) {
      const buffer = await zipFile.read(entry);
      if (entry === 'har.har')
        await fs.promises.writeFile(params.harFile, buffer);
      else
        await fs.promises.writeFile(path.join(dir, entry), buffer);
    }
    zipFile.close();
    await fs.promises.unlink(params.zipFile);
  }

  async connect(params: channels.LocalUtilsConnectParams, metadata: CallMetadata): Promise<channels.LocalUtilsConnectResult> {
    const controller = new ProgressController(metadata, this._object as SdkObject);
    controller.setLogName('browser');
    return await controller.run(async progress => {
      const wsHeaders = {
        'User-Agent': getUserAgent(),
        'x-playwright-proxy': params.exposeNetwork ?? '',
        ...params.headers,
      };
      const wsEndpoint = await urlToWSEndpoint(progress, params.wsEndpoint);

      const transport = await WebSocketTransport.connect(progress, wsEndpoint, wsHeaders, true, 'x-playwright-debug-log');
      const socksInterceptor = new SocksInterceptor(transport, params.exposeNetwork, params.socksProxyRedirectPortForTest);
      const pipe = new JsonPipeDispatcher(this);
      transport.onmessage = json => {
        if (socksInterceptor.interceptMessage(json))
          return;
        const cb = () => {
          try {
            pipe.dispatch(json);
          } catch (e) {
            transport.close();
          }
        };
        if (params.slowMo)
          setTimeout(cb, params.slowMo);
        else
          cb();
      };
      pipe.on('message', message => {
        transport.send(message);
      });
      transport.onclose = (reason?: string) => {
        socksInterceptor?.cleanup();
        pipe.wasClosed(reason);
      };
      pipe.on('close', () => transport.close());
      return { pipe, headers: transport.headers };
    }, params.timeout || 0);
  }

  async tracingStarted(params: channels.LocalUtilsTracingStartedParams, metadata?: CallMetadata | undefined): Promise<channels.LocalUtilsTracingStartedResult> {
    let tmpDir = undefined;
    if (!params.tracesDir)
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'playwright-tracing-'));
    const traceStacksFile = path.join(params.tracesDir || tmpDir!, params.traceName + '.stacks');
    this._stackSessions.set(traceStacksFile, { callStacks: [], file: traceStacksFile, writer: Promise.resolve(), tmpDir });
    return { stacksId: traceStacksFile };
  }

  async traceDiscarded(params: channels.LocalUtilsTraceDiscardedParams, metadata?: CallMetadata | undefined): Promise<void> {
    await this._deleteStackSession(params.stacksId);
  }

  async addStackToTracingNoReply(params: channels.LocalUtilsAddStackToTracingNoReplyParams, metadata?: CallMetadata | undefined): Promise<void> {
    for (const session of this._stackSessions.values()) {
      session.callStacks.push(params.callData);
      if (process.env.PW_LIVE_TRACE_STACKS) {
        session.writer = session.writer.then(() => {
          const buffer = Buffer.from(JSON.stringify(serializeClientSideCallMetadata(session.callStacks)));
          return fs.promises.writeFile(session.file, buffer);
        });
      }
    }
  }

  private async _deleteStackSession(stacksId?: string) {
    const session = stacksId ? this._stackSessions.get(stacksId) : undefined;
    if (!session)
      return;
    await session.writer;
    if (session.tmpDir)
      await removeFolders([session.tmpDir]);
    this._stackSessions.delete(stacksId!);
  }

  async setServerNetworkInterceptionPatterns(params: channels.LocalUtilsSetServerNetworkInterceptionPatternsParams, metadata?: CallMetadata): Promise<channels.LocalUtilsSetServerNetworkInterceptionPatternsResult> {
    if (!this._interceptionRegistry){
      this._interceptionRegistry = new ServerInterceptionRegistry();
      const server = new WorkerHttpServer();
      await server.start({ port: params.port });
      new MockingProxy(this._interceptionRegistry).install(server);
    }

    if (params.patterns.length === 0)
      return this._interceptionRegistry.setRequestInterceptor(params.scope);

    const interceptor: Interceptor = {
      patterns: params.patterns,
      route: (route, request) => {
        this._dispatchEvent('route', { route: RouteDispatcher.from(RequestDispatcher.from(this.parentScope() as any, request), route), scope: params.scope });
      },
      request: request => {
        this._dispatchEvent('request', { request: RequestDispatcher.from(this.parentScope() as any, request), scope: params.scope });
      },
      requestFinished: request => {
        this._dispatchEvent('requestFinished', { request: RequestDispatcher.from(this.parentScope() as any, request), scope: params.scope });
      },
      requestFailed: request => {
        this._dispatchEvent('requestFailed', { request: RequestDispatcher.from(this.parentScope() as any, request), scope: params.scope });
      },
      response: (request, response) => {
        this._dispatchEvent('response', {
          request: RequestDispatcher.from(this.parentScope() as any, request),
          response: ResponseDispatcher.from(this.parentScope() as any, response),
          scope: params.scope
        });
      },
    };
    this._interceptionRegistry.setRequestInterceptor(params.scope, interceptor);
  }
}

interface Interceptor {
  patterns: channels.LocalUtilsSetServerNetworkInterceptionPatternsParams['patterns'];
  route(route: Route, request: Request): void;
  request(request: Request): void;
  requestFinished(request: Request): void;
  requestFailed(request: Request): void;
  response(request: Request, response: Response): void;
}
type DoItFunction = (url: string, method: string, body: Buffer | null, headers: HeadersArray) => Promise<{ result: 'continue', guid: string, overrides: NormalizedContinueOverrides } | { result: 'abort', guid: string, errorCode: string } | { result: 'fulfill', guid: string, response: NormalizedFulfillResponse }>;

class ServerInterceptionRegistry {
  private _interceptors = new Map<string, Interceptor>();
  private readonly _requests = new Map<string, { request: Request, interceptor: Interceptor }>();

  setRequestInterceptor(scope: string, interceptor?: Interceptor) {
    if (interceptor)
      this._interceptors.set(scope, interceptor);
    else
      this._interceptors.delete(scope);
  }

  match(scope: string, url: string): DoItFunction | undefined {
    if (!this._interceptors.has(scope))
      return;

    const interceptor = this._interceptors.get(scope)!;
    if (!interceptor)
      return;

    const doIt: DoItFunction = (url, method, body, headers) => {
      return new Promise(resolve => {
        const fakeBrowserContext: BrowserContext = {
          attribution: null,
          addRouteInFlight() { },
          removeRouteInFlight() { },
          instrumentation: {
            onBeforeCall() { },
            onAfterCall() { }
          },
          emit() { }
        } as any;

        const request = new Request(fakeBrowserContext, null, null, null, undefined, url, '', method, body, headers);
        interceptor.request(request);

        const guid = request.guid;
        this._requests.set(guid, { request, interceptor });

        const route = new Route(request, {
          async abort(errorCode) {
            resolve({ result: 'abort', guid, errorCode });
          },
          async continue(overrides) {
            resolve({ result: 'continue', guid, overrides });
          },
          async fulfill(response) {
            resolve({ result: 'fulfill', guid, response });
          },
        });

        interceptor.route(route, request);
      });
    };

    const urlMatchers = interceptor.patterns.map(pattern => pattern.regexSource ? new RegExp(pattern.regexSource, pattern.regexFlags!) : pattern.glob!);
    const matchesSome = urlMatchers.some(urlMatch => urlMatches(undefined, url, urlMatch));
    if (matchesSome)
      return doIt;
  }

  finished(guid: string) {
    const request = this._requests.get(guid);
    if (!request)
      throw new Error('Internal error: missing request for response');
    request.interceptor.requestFinished(request.request);
  }

  failed(guid: string, error: string) {
    const request = this._requests.get(guid);
    if (!request)
      throw new Error('Internal error: missing request for response');
    this._requests.delete(guid);
    request.interceptor.requestFailed(request.request);
  }

  response(guid: string, status: number, statusText: string, headers: HeadersArray, body: () => Promise<Buffer>, timing: ResourceTiming, httpVersion: string) {
    const request = this._requests.get(guid);
    if (!request)
      throw new Error('Internal error: missing request for response');
    this._requests.delete(guid);
    const response = new Response(request.request, status, statusText, headers, timing, body, false, httpVersion);
    request.interceptor.response(request.request, response);
  }
}

function headersArray(req: Pick<http.IncomingMessage, 'headersDistinct'>): HeadersArray {
  return Object.entries(req.headersDistinct).flatMap(([name, values = []]) => values.map(value => ({ name, value })));
}

function headersArrayToOutgoingHeaders(headers: HeadersArray) {
  const result: http.OutgoingHttpHeaders = {};
  for (const { name, value } of headers) {
    if (result[name] === undefined)
      result[name] = value;
    else if (Array.isArray(result[name]))
      result[name].push(value);
    else
      result[name] = [result[name] as string, value];
  }
  return result;
}

async function collectBody(req: http.IncomingMessage) {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class WorkerHttpServer extends HttpServer {
  override _handleCORS(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    return false;
  }
}

class MockingProxy {
  private readonly _registry: ServerInterceptionRegistry;

  constructor(registry: ServerInterceptionRegistry) {
    this._registry = registry;
  }

  install(server: WorkerHttpServer) {
    server.routePrefix('/', (req, res) => {
      this._proxy(req, res);
      return true;
    });
    server.server().on('connect', (req, socket, head) => {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
    });
  }

  private async _proxy(req: http.IncomingMessage, res: http.ServerResponse) {
    const scope = '0';
    if (req.url?.startsWith('/'))
      req.url = req.url.substring(1);

    // Java URL likes removing double slashes from the pathname.
    if (req.url?.startsWith('http:/') && !req.url?.startsWith('http://'))
      req.url = req.url.replace('http:/', 'http://');
    if (req.url?.startsWith('https:/') && !req.url?.startsWith('https://'))
      req.url = req.url.replace('https:/', 'https://');

    const handler = this._registry.match(scope, req.url!);
    if (!handler) {
      res.statusCode = 404;
      res.end();
      return;
    }

    delete req.headersDistinct.host;

    const headers = headersArray(req);
    const body = await collectBody(req);

    const result = await handler(req.url!, req.method!, body, headers);
    switch (result.result) {
      case 'abort': {
        req.destroy(result.errorCode ? new Error(result.errorCode) : undefined);
        return;
      }
      case 'continue': {
        const { overrides } = result;
        const proxyUrl = url.parse(overrides.url ?? req.url!);
        const httpLib = proxyUrl.protocol === 'https:' ? https : http;
        const proxyHeaders = overrides.headers ?? headers;
        const proxyMethod = overrides.method ?? req.method;
        const proxyBody = overrides.postData ?? body;

        return new Promise<void>(resolve => {
          const proxyReq = httpLib.request({
            ...proxyUrl,
            headers: headersArrayToOutgoingHeaders(proxyHeaders),
            method: proxyMethod,
          }, async proxyRes => {
            res.writeHead(proxyRes.statusCode!, proxyRes.headers);

            try {
              const chunks: Buffer[] = [];
              await pipeline(
                  proxyRes,
                  new Transform({
                    transform(chunk, encoding, callback) {
                      chunks.push(chunk);
                      callback(undefined, chunk);
                    },
                  }),
                  res
              );

              this._registry.response(
                  result.guid,
                  proxyRes.statusCode!,
                  proxyRes.statusMessage!, headersArray(proxyRes),
                  async () => Buffer.concat(chunks),
                  {
                    startTime: 0,
                    domainLookupStart: 0,
                    domainLookupEnd: 0,
                    connectStart: 0,
                    secureConnectionStart: 0,
                    connectEnd: 0,
                    requestStart: 0,
                    responseStart: 0,
                  },
                  proxyRes.httpVersion
              );
              resolve();
            } catch (error) {
              this._registry.failed(result.guid, error.toString());
              resolve();
            }
          });

          proxyReq.on('error', error => {
            this._registry.failed(result.guid, error.toString());
            res.statusCode = 502;
            res.end(resolve);
          });
          proxyReq.end(proxyBody, () => {
            this._registry.finished(result.guid);
          });
        });
      }
      case 'fulfill': {
        const { response: { status, headers, body, isBase64 } } = result;
        res.statusCode = status;
        for (const { name, value } of headers)
          res.appendHeader(name, value);
        res.sendDate = false;
        res.end(Buffer.from(body, isBase64 ? 'base64' : 'utf-8'));
        return;
      }
      default: {
        throw new Error('Unexpected result');
      }
    }
  }
}

const redirectStatus = [301, 302, 303, 307, 308];

class HarBackend {
  readonly id = createGuid();
  private _harFile: har.HARFile;
  private _zipFile: ZipFile | null;
  private _baseDir: string | null;

  constructor(harFile: har.HARFile, baseDir: string | null, zipFile: ZipFile | null) {
    this._harFile = harFile;
    this._baseDir = baseDir;
    this._zipFile = zipFile;
  }

  async lookup(url: string, method: string, headers: HeadersArray, postData: Buffer | undefined, isNavigationRequest: boolean): Promise<{
      action: 'error' | 'redirect' | 'fulfill' | 'noentry',
      message?: string,
      redirectURL?: string,
      status?: number,
      headers?: HeadersArray,
    body?: Buffer
  }> {
    let entry;
    try {
      entry = await this._harFindResponse(url, method, headers, postData);
    } catch (e) {
      return { action: 'error', message: 'HAR error: ' + e.message };
    }

    if (!entry)
      return { action: 'noentry' };

    // If navigation is being redirected, restart it with the final url to ensure the document's url changes.
    if (entry.request.url !== url && isNavigationRequest)
      return { action: 'redirect', redirectURL: entry.request.url };

    const response = entry.response;
    try {
      const buffer = await this._loadContent(response.content);
      return {
        action: 'fulfill',
        status: response.status,
        headers: response.headers,
        body: buffer,
      };
    } catch (e) {
      return { action: 'error', message: e.message };
    }
  }

  private async _loadContent(content: { text?: string, encoding?: string, _file?: string }): Promise<Buffer> {
    const file = content._file;
    let buffer: Buffer;
    if (file) {
      if (this._zipFile)
        buffer = await this._zipFile.read(file);
      else
        buffer = await fs.promises.readFile(path.resolve(this._baseDir!, file));
    } else {
      buffer = Buffer.from(content.text || '', content.encoding === 'base64' ? 'base64' : 'utf-8');
    }
    return buffer;
  }

  private async _harFindResponse(url: string, method: string, headers: HeadersArray, postData: Buffer | undefined): Promise<har.Entry | undefined> {
    const harLog = this._harFile.log;
    const visited = new Set<har.Entry>();
    while (true) {
      const entries: har.Entry[] = [];
      for (const candidate of harLog.entries) {
        if (candidate.request.url !== url || candidate.request.method !== method)
          continue;
        if (method === 'POST' && postData && candidate.request.postData) {
          const buffer = await this._loadContent(candidate.request.postData);
          if (!buffer.equals(postData)) {
            const boundary = multipartBoundary(headers);
            if (!boundary)
              continue;
            const candidataBoundary = multipartBoundary(candidate.request.headers);
            if (!candidataBoundary)
              continue;
            // Try to match multipart/form-data ignroing boundary as it changes between requests.
            if (postData.toString().replaceAll(boundary, '') !== buffer.toString().replaceAll(candidataBoundary, ''))
              continue;
          }
        }
        entries.push(candidate);
      }

      if (!entries.length)
        return;

      let entry = entries[0];

      // Disambiguate using headers - then one with most matching headers wins.
      if (entries.length > 1) {
        const list: { candidate: har.Entry, matchingHeaders: number }[] = [];
        for (const candidate of entries) {
          const matchingHeaders = countMatchingHeaders(candidate.request.headers, headers);
          list.push({ candidate, matchingHeaders });
        }
        list.sort((a, b) => b.matchingHeaders - a.matchingHeaders);
        entry = list[0].candidate;
      }

      if (visited.has(entry))
        throw new Error(`Found redirect cycle for ${url}`);

      visited.add(entry);

      // Follow redirects.
      const locationHeader = entry.response.headers.find(h => h.name.toLowerCase() === 'location');
      if (redirectStatus.includes(entry.response.status) && locationHeader) {
        const locationURL = new URL(locationHeader.value, url);
        url = locationURL.toString();
        if ((entry.response.status === 301 || entry.response.status === 302) && method === 'POST' ||
          entry.response.status === 303 && !['GET', 'HEAD'].includes(method)) {
          // HTTP-redirect fetch step 13 (https://fetch.spec.whatwg.org/#http-redirect-fetch)
          method = 'GET';
        }
        continue;
      }

      return entry;
    }
  }

  dispose() {
    this._zipFile?.close();
  }
}

function countMatchingHeaders(harHeaders: har.Header[], headers: HeadersArray): number {
  const set = new Set(headers.map(h => h.name.toLowerCase() + ':' + h.value));
  let matches = 0;
  for (const h of harHeaders) {
    if (set.has(h.name.toLowerCase() + ':' + h.value))
      ++matches;
  }
  return matches;
}

export async function urlToWSEndpoint(progress: Progress|undefined, endpointURL: string): Promise<string> {
  if (endpointURL.startsWith('ws'))
    return endpointURL;

  progress?.log(`<ws preparing> retrieving websocket url from ${endpointURL}`);
  const fetchUrl = new URL(endpointURL);
  if (!fetchUrl.pathname.endsWith('/'))
    fetchUrl.pathname += '/';
  fetchUrl.pathname += 'json';
  const json = await fetchData({
    url: fetchUrl.toString(),
    method: 'GET',
    timeout: progress?.timeUntilDeadline() ?? 30_000,
    headers: { 'User-Agent': getUserAgent() },
  }, async (params: HTTPRequestParams, response: http.IncomingMessage) => {
    return new Error(`Unexpected status ${response.statusCode} when connecting to ${fetchUrl.toString()}.\n` +
        `This does not look like a Playwright server, try connecting via ws://.`);
  });
  progress?.throwIfAborted();

  const wsUrl = new URL(endpointURL);
  let wsEndpointPath = JSON.parse(json).wsEndpointPath;
  if (wsEndpointPath.startsWith('/'))
    wsEndpointPath = wsEndpointPath.substring(1);
  if (!wsUrl.pathname.endsWith('/'))
    wsUrl.pathname += '/';
  wsUrl.pathname += wsEndpointPath;
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return wsUrl.toString();
}

function multipartBoundary(headers: HeadersArray) {
  const contentType = headers.find(h => h.name.toLowerCase() === 'content-type');
  if (!contentType?.value.includes('multipart/form-data'))
    return undefined;
  const boundary = contentType.value.match(/boundary=(\S+)/);
  if (boundary)
    return boundary[1];
  return undefined;
}
