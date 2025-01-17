# class: ProxyFactory
* since: v1.51

This class is used for creating [Proxy] instances which in turn can be used to intercept network traffic from your application server. An instance
of this class can be obtained via [`property: Playwright.proxy`]. For more information
see [Proxy].

## async method: ProxyFactory.newProxy
* since: v1.16
- returns: <[Proxy]>

Creates a new instance of [Proxy].

### option: ProxyFactory.newProxy.port
* since: v1.51
- `port` ?<[int]>

Port to listen on. Defaults to random port.
