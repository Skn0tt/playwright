npx playwright start-mock

(Test Runner <-> Mock Server) <-> Application

start with HTTP messages - can later be used to represent any resource
potentially multiple apps

Scoping: either env var (needs be app-per-worker) or zones. start with app-per-worker

injected mock server endpoint: http://localhost:12345/<workerId>/<appId>/
in the future, that mock server might proxy to the original server

it has one API. the app-side instrumentation takes each outgoing request and sends it to the mock server:

Request:
POST /<workerId>/<appId>/__playwright/resolve
X-Playwright-Method: GET/POST...
X-Playwright-URL: https://api.contoso.com/foo/bar
...Headers
Body

The server takes the request, uses the worker ID to resolve the current test. appID is currently unused.
It asks the test to handle the request, and the test can respond with:

Response: { result: "fulfil", response: { ... } } | { result: "abort", errorCode } | { result: "continue", overrides: { ... } }
X-Playwright-Request-GUID: <guid>

This direction is then enacted by the instrumentation on the app.
The instrumentation also uses the GUID to report lifecycle events to the server:

POST /<workerId>/<appId>/__playwright/requests/<guid>/finished
POST /<workerId>/<appId>/__playwright/requests/<guid>/failed
POST /<workerId>/<appId>/__playwright/requests/<guid>/response
