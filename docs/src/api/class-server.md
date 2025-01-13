# class: Server
* since: v1.51

Lorem Ipsum dolor
async route(url: URLMatcher, handler: ServerRouteHandler) {
        this.repo.registerServerRoute(this.mockId, url, handler);
    }

    on(event: 'response', listener: (req: http.IncomingMessage, res: http.ServerResponse) => void): this;
    on(event: 'request', listener: (req: http.IncomingMessage, res: http.ServerResponse) => void): this;
    on(event: 'requestfinished', listener: (req: http.IncomingMessage, res: http.ServerResponse) => void): this;
    on(event: 'requestfailed', listener: (req: http.IncomingMessage, res: http.ServerResponse) => void): this;
    on(event: 'request' | 'response' | 'requestfinished' | 'requestfailed', listener: any) {
        return super.on(event, listener);
    };

## async method: Server.route
* since: v1.51

Lorem ipsum

### param: Server.route.url
* since: v1.51
- `url` <[string]|[RegExp]|[function]\([URL]\):[boolean]>

A glob pattern, regex pattern or predicate receiving [URL] to match while routing.
When a [`option: Browser.newContext.baseURL`] via the context options was provided and the passed URL is a path,
it gets merged via the [`new URL()`](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL) constructor.

### param: Server.route.handler
* since: v1.51
* langs: js, python
- `handler` <[function]\([Route], [Request]\): [Promise<any>|any]>

handler function to route the request.

### param: Server.route.handler
* since: v1.51
* langs: csharp, java
- `handler` <[function]\([Route]\)>

handler function to route the request.

### option: Server.route.times
* since: v1.51
- `times` <[int]>

How often a route should be used. By default it will be used every time.

## async method: Server.unrouteAll
* since: v1.51

Removes all routes created with [`method: Server.route`].

### option: Server.unrouteAll.behavior = %%-unroute-all-options-behavior-%%
* since: v1.51

## async method: Server.unroute
* since: v1.51

Removes a route created with [`method: Server.route`]. When [`param: handler`] is not specified, removes all
routes for the [`param: url`].

### param: Server.unroute.url
* since: v1.51
- `url` <[string]|[RegExp]|[function]\([URL]\):[boolean]>

A glob pattern, regex pattern or predicate receiving [URL] used to register a routing with
[`method: Server.route`].

### param: Server.unroute.handler
* since: v1.51
* langs: js, python
- `handler` ?<[function]\([Route], [Request]\): [Promise<any>|any]>

Optional handler function used to register a routing with [`method: Server.route`].

### param: Server.unroute.handler
* since: v1.51
* langs: csharp, java
- `handler` ?<[function]\([Route]\)>

Optional handler function used to register a routing with [`method: Server.route`].

## event: Server.request
* since: v1.51
- argument: <[Request]>

Emitted when a server issues a request. The [request] object is read-only. In order to intercept and mutate requests, see
[`method: Server.route`].

## event: Server.requestfailed
* since: v1.51
- argument: <[Request]>

Emitted when a request fails, for example by timing out.

## event: Server.requestfinished
* since: v1.51
- argument: <[Request]>

Emitted when a request finishes successfully after downloading the response body. For a successful response, the
sequence of events is `request`, `response` and `requestfinished`.

## event: Server.response
* since: v1.51
- argument: <[Response]>

Emitted when [response] status and headers are received for a request. For a successful response, the sequence of events
is `request`, `response` and `requestfinished`.
