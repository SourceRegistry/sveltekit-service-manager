<div align="center">

# @sourceregistry/sveltekit-service-manager

**A small service gateway, router, and client for SvelteKit backends**

[![npm version](https://img.shields.io/npm/v/@sourceregistry/sveltekit-service-manager?style=flat-square&color=f96743)](https://www.npmjs.com/package/@sourceregistry/sveltekit-service-manager)
[![npm downloads](https://img.shields.io/npm/dm/@sourceregistry/sveltekit-service-manager?style=flat-square)](https://www.npmjs.com/package/@sourceregistry/sveltekit-service-manager)
[![license](https://img.shields.io/npm/l/@sourceregistry/sveltekit-service-manager?style=flat-square)](./LICENSE)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-%5E2-FF3E00?style=flat-square&logo=svelte&logoColor=white)](https://kit.svelte.dev)
[![issues](https://img.shields.io/github/issues/SourceRegistry/sveltekit-service-manager?style=flat-square)](https://github.com/SourceRegistry/sveltekit-service-manager/issues)

Expose modular backend services through versioned SvelteKit gateway routes. Keep service routing, lifecycle, internal calls, browser calls, and optional Node middleware adapters in one small package.

[Docs](https://sourceregistry.github.io/sveltekit-service-manager/) | [npm](https://www.npmjs.com/package/@sourceregistry/sveltekit-service-manager) | [Issues](https://github.com/SourceRegistry/sveltekit-service-manager/issues)

</div>

---

## Installation

```sh
npm install @sourceregistry/sveltekit-service-manager
```

**Peer dependency:** `svelte ^5.0.0`

In this repository examples may import from `$lib/server/index.js`. In applications, import from `@sourceregistry/sveltekit-service-manager`.

---

## Overview

```ts
// src/routes/api/v1/services/[service_name]/[...catch]/+server.ts
import { ServiceManager } from '@sourceregistry/sveltekit-service-manager';

const { endpoint, access } = ServiceManager.Base(undefined, {
    accessKey: 'api:v1',
});

export const { GET, POST, PUT, DELETE, PATCH, HEAD } = endpoint;

access('ping', 'users');
```

```ts
// src/lib/server/services/ping.service.ts
import { Action, Router, ServiceManager, type Service } from '@sourceregistry/sveltekit-service-manager';

const router = Router()
    .GET('/health', () => Action.success(200, { ok: true }))
    .GET('/echo/[message]', ({ params }) => Action.success(200, { message: params.message }));

const service = {
    name: 'ping',
    route: router,
} satisfies Service<'ping'>;

export default ServiceManager.Load(service, import.meta);
```

This exposes:

```txt
/api/v1/services/ping/health
/api/v1/services/ping/echo/hello
```

---

## Core API

Import server utilities from `@sourceregistry/sveltekit-service-manager` or `@sourceregistry/sveltekit-service-manager/server`.

### `ServiceManager.Base`

Creates SvelteKit request handlers for a gateway route. The default selector reads `event.params.service_name`, which matches `[service_name]`.

```ts
import { ServiceManager } from '@sourceregistry/sveltekit-service-manager';

const { endpoint, access } = ServiceManager.Base(undefined, {
    accessKey: 'public',
});

export const { GET, POST, PUT, DELETE, PATCH, HEAD } = endpoint;

access('ping', 'status');
```

Use a stable `accessKey` for each gateway. Allow-lists are stored on the singleton service manager so they survive Vite HMR recreations.

Requests for unknown services and blocked services both fail as inaccessible. This avoids exposing which service names are registered.

### `ServiceManager.Load`

Registers a service definition and wires Vite HMR cleanup when `import.meta` is passed.

```ts
import { ServiceManager, Router } from '@sourceregistry/sveltekit-service-manager';

const service = {
    name: 'users',
    route: Router().GET('/me', ({ locals }) => Response.json({ user: locals.user })),
    cleanup: async () => {
        // close timers, workers, sockets, or pools owned by this service
    },
};

export default ServiceManager.Load(service, import.meta);
```

During HMR, `cleanup()` runs, router routes are reset, the old service is unregistered, and the updated module can register fresh handlers.

### `Router`

Creates a service-relative router. Routes use SvelteKit-style segments: static paths, `[param]`, and `[...catchAll]`.

```ts
import { Action, Router } from '@sourceregistry/sveltekit-service-manager';

export const router = Router()
    .GET('/health', () => Action.success(200, { ok: true }))
    .POST('/users/[id]', ({ params }) => Action.success(200, { updated: params.id }))
    .GET('/files/[...path]', ({ params }) => Action.success(200, { path: params.path }));
```

Supported methods: `GET`, `PUT`, `POST`, `DELETE`, `HEAD`, `PATCH`, `OPTIONS`. `USE(path, handler, methods?)` registers one handler for multiple methods.

### Nested routers

```ts
const users = Router().GET('/profile', ({ params }) => Action.success(200, { userId: params.id }));

const api = Router().use('/users/[id]', users);
```

`/users/42/profile` reaches the nested router with `params.id === '42'`.

### Pre and post hooks

```ts
const router = Router()
    .pre((event) => {
        const token = event.cookies.get('token');
        if (!token) return Action.error(401, { message: 'Unauthorized' } as any);

        return {
            ...event,
            locals: { ...event.locals, token },
        } as any;
    })
    .GET('/private', ({ locals }) => Action.success(200, { token: (locals as any).token }))
    .post((_event, response) => {
        const headers = new Headers(response.headers);
        headers.set('x-service-router', '1');
        return new Response(response.body, { status: response.status, headers });
    });
```

Keep hooks small. Use `pre` for auth, tenant, actor, tracing, and maintenance stops. Use `post` for response metadata and shaping.

### `middleware`

Composes guard functions with a final service handler. Guard return objects are merged into `context` and the deprecated `guard` alias.

```ts
import { Action, middleware } from '@sourceregistry/sveltekit-service-manager';

const requireAuth = async ({ cookies }) => {
    const token = cookies.get('token');
    if (!token) throw Action.error(401, { message: 'Unauthorized' } as any);
    return { token };
};

export const route = middleware(
    async ({ context }) => Action.success(200, { token: context.token }),
    requireAuth,
);
```

Only real SvelteKit HTTP errors and redirects are treated as framework control flow. Other thrown values go through middleware error handlers or are rethrown.

### `Service`

Calls a service-local function or returns a local value without HTTP.

```ts
import { Service } from '@sourceregistry/sveltekit-service-manager';

const user = await Service('users', 'current');
```

The call is typed through `App.Services`.

---

## Client API

Import browser/client utilities from `@sourceregistry/sveltekit-service-manager/client`.

### `Service(name, config?)`

Creates a typed browser caller for public services.

```ts
import { Service } from '@sourceregistry/sveltekit-service-manager/client';

const ping = Service('ping');

const result = await ping.call('/health');
```

#### Route building

```ts
ping.route('/health'); // /api/v1/services/ping/health
```

To include the current page search params, pass the current URL:

```ts
const ping = Service('ping', { url });

ping.route('/health', { includeSearchParams: true });
```

#### POST JSON

```ts
await ping.call('/echo', { message: 'hello' });
```

Passing a body defaults the method to `POST`, JSON-serializes plain objects, and sets `content-type: application/json`.

#### Custom entrypoint or fetch

```ts
const ping = Service('ping', {
    entryPoint: '/api/v1/services',
    executor: fetch,
});
```

Entrypoints with `[param]` or `[...param]` placeholders are resolved from `config.params`.

### `ServiceError`

Failed calls throw `ServiceError`.

```ts
import { ServiceError } from '@sourceregistry/sveltekit-service-manager/client';

try {
    await ping.call('/private');
} catch (error) {
    if (error instanceof ServiceError) {
        console.error(error.code);
        console.error(error.data);
    }
}
```

---

## Response Helpers

```ts
import { Action, error, fail, file, json, text } from '@sourceregistry/sveltekit-service-manager';

Action.success(200, { ok: true });
Action.fail(400, { field: 'email' });
Action.error(401, { message: 'Unauthorized' } as any);
Action.redirect(302, '/login');

json({ ok: true });
text('hello');
file(blob, { mode: 'attachment', filename: 'report.csv' });
fail({ message: 'Bad request' }, { status: 400 });
error({ message: 'Internal error' }, { status: 500 });
```

Security-sensitive behavior:

- `json()` and `text()` set `Content-Length` from UTF-8 byte length.
- `file()` sanitizes the fallback `filename` value and emits `filename*` for encoded names.
- `Action.*` responses use JSON bodies with a `type` and `status` field.

---

## Node Adapters

### `Proxy`

Runs a Node-style request listener, such as an Express app, inside a Fetch/SvelteKit service route.

```ts
import express from 'express';
import { Proxy } from '@sourceregistry/sveltekit-service-manager';

const app = express();
app.get('/hello', (_req, res) => res.json({ hello: 'world' }));

const proxy = new Proxy(app);

export const service = {
    name: 'express-demo',
    route: (event) => proxy.handle(event),
};
```

### `Server`

Runs a `Router` or request handler as a standalone HTTP/HTTPS server.

```ts
import { Router, Server } from '@sourceregistry/sveltekit-service-manager';

const router = Router().GET('/health', () => new Response('ok'));

new Server(
    {
        router,
        origin: 'https://api.example.com',
        allowedHosts: ['api.example.com'],
    },
    { type: 'http' },
).listen(3000);
```

Standalone server hardening:

- malformed `Host` headers are rejected;
- `allowedHosts` restricts accepted hostnames;
- `origin` pins `event.url` to a trusted origin;
- cookies default to `httpOnly: true`, `sameSite: 'lax'`, and `secure: true` outside localhost. Callers may override these options explicitly.

---

## Production Guidance

- Use explicit gateway allow-lists with stable `accessKey` values.
- Add auth in router `pre` hooks or `middleware` guards.
- Use route methods deliberately and rely on built-in `405` and `Allow` responses.
- Keep service `load()` side-effect-light and release resources in `cleanup()`.
- Use `Service()` for internal in-process calls when HTTP is unnecessary.
- For standalone servers, configure `origin` and `allowedHosts`.
- Add tests for access control, method restrictions, auth failures, and nested routing.
- Keep dependency audit clean in CI.

---

## Type Reference

```ts
// Gateway and service management
ServiceManager.Base(selector?, options?)
ServiceManager.Load(service, importMeta?)
ServiceManager.Reload(name)
ServiceManager.Internal(name, ...args)

// Router
Router()
ServiceRouter
RouteHandler<Path>
PreRouteHandler
PostRouteHandler
RequestMethods

// Service contracts
Service<T, Args, Local>
ServiceHandler<Params, RouteId>
ServiceRequestEvent<Params, RouteId>
ServiceEndpoint

// Client
Service(name, config?)
ServiceError
PublicServices

// Node adapters
Proxy
Server
```

---

## Exports

### Server

- `ServiceManager`
- `ServiceRouter` / `Router`
- `Service` for internal calls
- `Action`
- `middleware`
- `Server`
- `Proxy`
- `json`, `text`, `html`, `file`, `fail`, `error`

### Client

- `Service`
- `ServiceError`
- `PublicServices`

---

## Testing

```sh
npm test
npm run check
```

---

## License

[Apache-2.0](./LICENSE) (c) [A.P.A. Slaa](https://github.com/SourceRegistry)
