# 🔧 @sourceregistry/sveltekit-service-manager

[![npm version](https://img.shields.io/npm/v/@sourceregistry/sveltekit-service-manager?logo=npm)](https://www.npmjs.com/package/@sourceregistry/sveltekit-service-manager)
[![License](https://img.shields.io/npm/l/@sourceregistry/sveltekit-service-manager)](https://github.com/SourceRegistry/sveltekit-service-manager/blob/main/LICENSE)
[![CI](https://github.com/SourceRegistry/sveltekit-service-manager/actions/workflows/test.yml/badge.svg)](https://github.com/SourceRegistry/sveltekit-service-manager/actions)
[![Codecov](https://img.shields.io/codecov/c/github/SourceRegistry/sveltekit-service-manager)](https://codecov.io/gh/SourceRegistry/sveltekit-service-manager)

A **minimal, production-oriented service gateway** for **SvelteKit**.

This library provides a structured way to expose backend services through versioned gateway routes while keeping services modular, testable, and HMR-safe.

---

## Why this exists

SvelteKit routes are powerful, but for **larger backends** you often want:

- a **single gateway** (`/api/v1/services/...`)
- **modular services** with their own routers and lifecycle
- **internal calls** without HTTP
- **safe hot reload** during development
- optional **Express / Node middleware reuse**
- a **typed client** to call services from the browser

This project solves that without introducing a full framework.

---

## Features

- 🚪 Versioned service gateways (`/api/v1/services/<service>/<path…>`)
- 🔐 Per-gateway **allowlists**
- 🔁 Clean **Vite HMR** (cleanup + route reset + re-register)
- 🧭 Fast, typed **service-relative router**
- 🧠 Internal service calls (no HTTP hop)
- 🛡️ Middleware guards
- 🔌 Express / Node middleware compatibility (Fetch adapter)
- 🌐 Typed **client-side service caller**

---

## Project structure

```txt
├── src
│   ├── lib
│   │   ├── client          # Client-side service caller
│   │   └── server
│   │       └── helpers
│   └── routes
│       └── api
│           └── v1
│               └── services
│                   └── [service_name]
│                       └── [...catch]
│                           └── +server.ts
├── static
└── tests
    └── services
````

---

## Installation

```bash
npm i @sourceregistry/sveltekit-service-manager
```

> In this repository you may see `$lib/server/index.js`.
> In production **always import from the package**.

---

## Gateway setup

### Example gateway route

`src/routes/api/v1/services/[service_name]/[...catch]/+server.ts`

```ts
import { ServiceManager } from '@sourceregistry/sveltekit-service-manager';

const { endpoint, access } = ServiceManager.Base(undefined, {
  accessKey: 'api:v1'
});

export const { GET, POST, PUT, DELETE, PATCH, HEAD } = endpoint;

// Allow only selected services through this gateway
access('ping', 'users');
```

This exposes:

```
/api/v1/services/ping/*
/api/v1/services/users/*
```

---

## Multiple gateways (public / internal)

Each gateway gets its **own allowlist**, isolated even across HMR:

```ts
// Public API
ServiceManager.Base(undefined, { accessKey: 'public' }).access('ping');

// Internal API
ServiceManager.Base(undefined, { accessKey: 'internal' }).access('admin', 'metrics');
```

---

## Defining a service

### Router-based service (recommended)

```ts
import { Router, Action, ServiceManager } from '@sourceregistry/sveltekit-service-manager';

const router = Router()
  .GET('/health', () => Action.success(200, { ok: true }))
  .GET('/echo/[msg]', ({ params }) =>
    Action.success(200, { msg: params.msg })
  );

export const service = {
  name: 'ping',
  route: router
};

export default ServiceManager
  .Load(service, import.meta)
  .finally(() => console.log('[Service]', `[${service.name}]`, 'Loaded'));
```

Accessible via:

```
/api/v1/services/ping/health
/api/v1/services/ping/echo/hello
```

---

## Hot Module Reloading (HMR)

When loading a service with:

```ts
ServiceManager.Load(service, import.meta)
```

The following happens automatically during Vite HMR:

1. `cleanup()` is called (if defined)
2. Router routes are **fully reset**
3. Service is unregistered
4. Updated module is reloaded
5. Routes are re-registered

This prevents:

* duplicate routes
* stale handlers
* memory leaks

---

## Middleware guards

Compose guards and pass combined state to handlers:

```ts
import { middleware, Action } from '@sourceregistry/sveltekit-service-manager';

const requireAuth = async ({ cookies }) => {
  const token = cookies.get('token');
  if (!token) throw Action.error(401, { message: 'Unauthorized' } as any);
  return { token };
};

export const service = {
  name: 'users',
  route: middleware(
    async ({ guard }) => Action.success(200, { token: guard.token }),
    requireAuth
  )
};
```

---

## Internal service calls (no HTTP)

If a service defines `local`, you can call it directly:

```ts
import { Service } from '@sourceregistry/sveltekit-service-manager';

const value = Service('ping');
```

This is fully typed via `App.Services`.

---

## Client-side usage

The client helper provides a **typed, ergonomic way** to call public services.

### Basic usage

```ts
import { Service } from '$lib/client';

const ping = Service('ping');

const result = await ping.call('/health');
```

### With route helpers

```ts
ping.route('/health'); // "/api/v1/services/ping/health"
```

### POST with JSON body

```ts
await ping.call('/echo', { message: 'hello' });
```

---

## Client error handling

Errors throw a `ServiceError`:

```ts
try {
  await ping.call('/fail');
} catch (e) {
  if (e instanceof ServiceError) {
    console.error(e.code);     // HTTP status
    console.error(e.data);     // parsed JSON or text
  }
}
```

---

## Custom entrypoint or fetch

```ts
Service('ping', {
  entryPoint: '/api/v1/services',
  executor: fetch
});
```

Supports dynamic `[param]` resolution using `Page.params`.

---

## Express / Node middleware integration

You can run Express (or similar) inside a service:

```ts
import express from 'express';
import { Proxy } from '@sourceregistry/sveltekit-service-manager';

const app = express();
app.get('/hello', (_req, res) => res.json({ hello: 'world' }));

const proxy = new Proxy(app);

export const service = {
  name: 'express-demo',
  route: (event) => proxy.handle(event)
};
```

---

## Exports

### Server

* `ServiceManager`
* `ServiceRouter` / `Router`
* `Service` (internal call)
* `Action`
* `middleware`
* `Server` (WebHTTPServer)
* `Proxy` (WebProxyServer)
* `json`, `text`, `html`, `file`, `fail`, `error`

### Client

* `Service`
* `ServiceError`
* `PublicServices`

---

## Testing

```bash
npm test
```

Tests live in `tests/services`.

---

## License

Apache 2.0 see LICENSE
