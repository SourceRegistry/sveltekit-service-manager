import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { error as skError, redirect as skRedirect } from "@sveltejs/kit";

// ✅ IMPORTANT: mock SvelteKit public env import used by client module
vi.mock("$env/dynamic/public", () => ({
    env: {
        PUBLIC_SERVICE_ENTRYPOINT: "/api/v1/services"
    }
}));

import {
    Router,
    Action,
    ServiceManager,
    middleware,
    Proxy,
    Server,
    json,
    text,
    html,
    fail,
    error,
    file
} from "../src/lib/server/index.js";

import { Service as ClientService, ServiceError } from "../src/lib/client/index.js";
import * as devalue from "devalue";

const nativeFetch = globalThis.fetch;

/**
 * Small unique id helper for service names (prevents singleton registry collisions).
 */
const uid = (prefix = "svc") => `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now()}`;

/**
 * Minimal cookies stub (enough for middleware + client usage in tests).
 */
function mockCookies() {
    const jar = new Map<string, string>();
    return {
        get: (k: string) => jar.get(k),
        getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
        set: (k: string, v: string) => void jar.set(k, v),
        delete: (k: string) => void jar.delete(k),
        serialize: (name: string, value: string) => `${name}=${value}`
    } as any;
}

/**
 * Create a ServiceRequestEvent-like object for testing ServiceRouter directly.
 */
function mockServiceEvent(pathname: string, init?: Partial<{ method: string; url: string }>) {
    const url = new URL(init?.url ?? `http://local${pathname}`);
    const request = new Request(url, { method: init?.method ?? "GET" });

    return {
        request,
        url,
        fetch: globalThis.fetch,
        cookies: mockCookies(),
        locals: {},
        platform: {},
        params: {},
        route: {
            id: null,
            base: "",
            service: pathname,
            serviceURL: url,
            baseURL: new URL("/", url),
            originalURL: new URL(url)
        },
        getClientAddress: () => "127.0.0.1",
        setHeaders: () => {}
    } as any;
}

/**
 * Create a RequestEvent-like object for testing ServiceManager.Base endpoint handlers.
 *
 * NOTE: route.id must include a `[...catch]` segment because ServiceManager.createServiceRequest
 * derives base/service paths from it.
 */
function mockGatewayEvent(args: {
    entrypoint?: string; // e.g. "/api/v1/services"
    service: string;
    rest?: string; // e.g. "/health"
    method?: string;
}) {
    const entry = args.entrypoint ?? "/api/v1/services";
    const rest = args.rest ?? "/";
    const pathname = `${entry}/${args.service}${rest.startsWith("/") ? rest : `/${rest}`}`;
    const url = new URL(`http://local${pathname}`);
    const request = new Request(url, { method: args.method ?? "GET" });

    // A route.id that matches: /api/v1/services/[service_name]/[...catch]
    // This is what your createServiceRequest expects.
    const routeId = `${entry}/[service_name]/[...catch]`;

    return {
        request,
        url,
        fetch: globalThis.fetch,
        cookies: mockCookies(),
        locals: {},
        platform: {},
        params: {
            service_name: args.service
        },
        route: { id: routeId },
        getClientAddress: () => "127.0.0.1",
        setHeaders: () => {}
    } as any;
}

/**
 * Because ServiceManager is a singleton with private state, we keep tests isolated by:
 * - using unique service names (uid())
 * - reloading/unregistering what we loaded in each test
 */
const loaded: string[] = [];
async function loadService(svc: any, mod?: any) {
    loaded.push(svc.name);
    return ServiceManager.Load(svc, mod);
}
async function cleanupLoaded() {
    // best-effort: reload unregisters + resets router
    await Promise.allSettled(loaded.splice(0).map((n) => ServiceManager.Reload(n)));
}

afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = nativeFetch;
    await cleanupLoaded();
});

describe("ServiceRouter", () => {
    it("matches static routes", async () => {
        const router = Router().GET("/health", () => Action.success(200, { ok: true }));

        const res = await router.handle(mockServiceEvent("/health"));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.type).toBe("success");
    });

    it("extracts [param] params", async () => {
        const router = Router().GET("/users/[id]", ({ params }) => Action.success(200, { id: params.id }));

        const res = await router.handle(mockServiceEvent("/users/123"));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(devalue.parse(body.data)).toEqual({ id: "123" });
    });

    it("prioritizes static over params and catch-all", async () => {
        const router = Router()
            .GET("/users/me", () => Action.success(200, { who: "me" }))
            .GET("/users/[id]", ({ params }) => Action.success(200, { who: params.id }))
            .GET("/users/[...rest]", ({ params }) => Action.success(200, { who: params.rest }));

        const res = await router.handle(mockServiceEvent("/users/me"));
        const body = await res.json();

        expect(devalue.parse(body.data)).toEqual({ who: "me" });
    });

    it("supports nested routers + prefix params", async () => {
        // @ts-ignore
        const child = Router().GET("/profile", ({ params }) => Action.success(200, { userId: params.id }));
        const root = Router().use("/users/[id]", child);

        const res = await root.handle(mockServiceEvent("/users/42/profile"));
        const body = await res.json();

        expect(devalue.parse(body.data)).toEqual({ userId: "42" });
    });

    it("runs pre hooks before route handling and can replace event", async () => {
        const router = Router()
            .pre((event) => ({
                ...event,
                locals: { ...event.locals, traceId: "trace-1" }
            }) as any)
            .GET("/health", ({ locals }) => Action.success(200, { traceId: (locals as any).traceId }));

        const res = await router.handle(mockServiceEvent("/health"));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(devalue.parse(body.data)).toEqual({ traceId: "trace-1" });
    });

    it("allows pre hooks to short-circuit with a response", async () => {
        const handler = vi.fn(() => Action.success(200, { ok: true }));
        const router = Router()
            .pre(() => Action.error(401, { message: "Unauthorized" } as any))
            .GET("/health", handler);

        const res = await router.handle(mockServiceEvent("/health"));
        const body = await res.json();

        expect(res.status).toBe(401);
        expect(body.type).toBe("error");
        expect(handler).not.toHaveBeenCalled();
    });

    it("runs post hooks after handling and can replace response", async () => {
        const router = Router()
            .GET("/health", () => Action.success(200, { ok: true }))
            .post((_event, response) => {
                const headers = new Headers(response.headers);
                headers.set("x-post-hook", "applied");
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers
                });
            });

        const res = await router.handle(mockServiceEvent("/health"));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get("x-post-hook")).toBe("applied");
        expect(body.type).toBe("success");
    });

    it("returns 405 with Allow header when path exists but method does not", async () => {
        const router = Router().GET("/health", () => Action.success(200, { ok: true }));

        const res = await router.handle(mockServiceEvent("/health", { method: "POST" }));
        const body = await res.json();

        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toContain("GET");
        expect(res.headers.get("allow")).toContain("HEAD");
        expect(res.headers.get("allow")).toContain("OPTIONS");
        expect(body.message).toContain("Method POST not allowed");
    });

    it("handles OPTIONS automatically for known paths", async () => {
        const router = Router()
            .GET("/health", () => Action.success(200, { ok: true }))
            .POST("/health", () => Action.success(200, { ok: true }));

        const res = await router.handle(mockServiceEvent("/health", { method: "OPTIONS" }));

        expect(res.status).toBe(204);
        expect(res.headers.get("allow")).toContain("GET");
        expect(res.headers.get("allow")).toContain("POST");
        expect(res.headers.get("allow")).toContain("HEAD");
        expect(res.headers.get("allow")).toContain("OPTIONS");
    });

    it("throws 404 on unknown routes", async () => {
        const router = Router().GET("/ok", () => new Response("ok"));

        await expect(() => router.handle(mockServiceEvent("/nope"))).rejects.toMatchObject({ status: 404 });
    });

    it("supports HEAD, PATCH, DELETE, PUT and USE registrations", async () => {
        const router = Router()
            .HEAD("/resource", () => new Response(null, { status: 204 }))
            .PUT("/resource", () => new Response("put"))
            .PATCH("/resource", () => new Response("patch"))
            .DELETE("/resource", () => new Response("delete"))
            .USE("/multi", ({ request }) => new Response(request.method), ["GET", "POST"]);

        expect((await router.handle(mockServiceEvent("/resource", { method: "HEAD" }))).status).toBe(204);
        expect(await (await router.handle(mockServiceEvent("/resource", { method: "PUT" }))).text()).toBe("put");
        expect(await (await router.handle(mockServiceEvent("/resource", { method: "PATCH" }))).text()).toBe("patch");
        expect(await (await router.handle(mockServiceEvent("/resource", { method: "DELETE" }))).text()).toBe("delete");
        expect(await (await router.handle(mockServiceEvent("/multi", { method: "POST" }))).text()).toBe("POST");
    });

    it("supports action handlers for success, failure, http error and redirect", async () => {
        const router = Router()
            .action("/submit/[id]", async ({ params }) => ({ id: params.id } as any))
            .action("/fail", async () => ({ type: "failure", status: 422, data: { invalid: true } } as any))
            .action("/http-error", async () => {
                throw skError(418, { message: "teapot" });
            })
            .action("/redirect", async () => {
                throw skRedirect(303, "/next");
            });

        const ok = await router.handle(mockServiceEvent("/submit/42", { method: "POST" }));
        expect(devalue.parse((await ok.json()).data)).toEqual({ id: "42" });

        const failed = await router.handle(mockServiceEvent("/fail", { method: "POST" }));
        expect(failed.status).toBe(422);
        expect((await failed.json()).type).toBe("failure");

        const errored = await router.handle(mockServiceEvent("/http-error", { method: "POST" }));
        expect(errored.status).toBe(418);
        expect((await errored.json()).type).toBe("error");

        const redirected = await router.handle(mockServiceEvent("/redirect", { method: "POST" }));
        expect(redirected.status).toBe(303);
        expect((await redirected.json()).location).toBe("/next");
    });

    it("can discard route methods, nested routers and reset all handlers", async () => {
        const child = Router().GET("/item", () => new Response("child"));
        const router = Router()
            .GET("/a", () => new Response("get"))
            .POST("/a", () => new Response("post"))
            .use("/nested", child);

        router.discard("/a", "GET");
        expect((await router.handle(mockServiceEvent("/a"))).status).toBe(405);
        expect(await (await router.handle(mockServiceEvent("/a", { method: "POST" }))).text()).toBe("post");

        router.discard("/nested");
        await expect(() => router.handle(mockServiceEvent("/nested/item"))).rejects.toMatchObject({ status: 404 });

        router.reset();
        await expect(() => router.handle(mockServiceEvent("/a", { method: "POST" }))).rejects.toMatchObject({ status: 404 });
    });
});

describe("ServiceManager.Base + access control", () => {
    it("allows only whitelisted services for a gateway", async () => {
        const pingName = uid("ping");
        const secretName = uid("secret");

        await loadService({
            name: pingName,
            route: Router().GET("/health", () => Action.success(200, { ok: true }))
        });

        await loadService({
            name: secretName,
            route: Router().GET("/health", () => Action.success(200, { ok: false }))
        });

        const { endpoint, access } = ServiceManager.Base(undefined, { accessKey: uid("gw") });
        access(pingName as any);

        // allowed
        const okRes = await endpoint.GET(
            mockGatewayEvent({ service: pingName, rest: "/health", method: "GET" })
        );
        expect(okRes.status).toBe(200);

        // blocked
        await expect(() =>
            endpoint.GET(mockGatewayEvent({ service: secretName, rest: "/health", method: "GET" }))
        ).rejects.toMatchObject({ status: 403 });
    });

    it("isolates allowlists across multiple gateways via accessKey", async () => {
        const a = uid("a");
        const b = uid("b");

        await loadService({ name: a, route: Router().GET("/x", () => new Response("a")) });
        await loadService({ name: b, route: Router().GET("/x", () => new Response("b")) });

        const gw1 = ServiceManager.Base(undefined, { accessKey: "gw1-" + uid() });
        const gw2 = ServiceManager.Base(undefined, { accessKey: "gw2-" + uid() });

        gw1.access(a as any);
        gw2.access(b as any);

        const r1 = await gw1.endpoint.GET(mockGatewayEvent({ service: a, rest: "/x" }));
        expect(await r1.text()).toBe("a");

        const r2 = await gw2.endpoint.GET(mockGatewayEvent({ service: b, rest: "/x" }));
        expect(await r2.text()).toBe("b");

        await expect(() => gw1.endpoint.GET(mockGatewayEvent({ service: b, rest: "/x" }))).rejects.toMatchObject({
            status: 403
        });
    });

    it("does not reveal whether an unlisted service exists", async () => {
        const { endpoint, access } = ServiceManager.Base(undefined, { accessKey: uid("gw") });
        access(uid("allowed") as any);

        await expect(() =>
            endpoint.GET(mockGatewayEvent({ service: uid("missing"), rest: "/x" }))
        ).rejects.toMatchObject({ status: 403 });
    });

    it("supports query-string service selection", async () => {
        const name = uid("query");
        await loadService({ name, route: Router().GET("/x", () => new Response("query-ok")) });

        const gateway = ServiceManager.Base(ServiceManager.ServiceSelector.query("svc"), { accessKey: uid("gw") });
        gateway.access(name as any);

        const event = mockGatewayEvent({ service: "ignored", rest: "/x" });
        event.url.searchParams.set("svc", name);
        event.request = new Request(event.url, { method: "GET" });

        const res = await gateway.endpoint.GET(event);
        expect(await res.text()).toBe("query-ok");
    });

    it("returns service route and method errors from gateways", async () => {
        const name = uid("svc");
        const noRoute = uid("noroute");
        await loadService({ name, route: { GET: () => new Response("ok") } });
        await loadService({ name: noRoute });

        const gateway = ServiceManager.Base(undefined, { accessKey: uid("gw") });
        gateway.access(name as any, noRoute as any);

        await expect(() => gateway.endpoint.POST(mockGatewayEvent({ service: name, method: "POST" }))).rejects.toMatchObject({ status: 405 });
        await expect(() => gateway.endpoint.GET(mockGatewayEvent({ service: noRoute, method: "GET" }))).rejects.toMatchObject({ status: 503 });
    });
});

describe("ServiceManager.Load HMR integration", () => {
    it("calls cleanup and resets router on Reload", async () => {
        const name = uid("hmr");
        let cleaned = 0;
        const router = Router().GET("/a", () => new Response("a"));

        await loadService({
            name,
            route: router,
            cleanup: async () => {
                cleaned++;
            }
        });

        expect(await (await router.handle(mockServiceEvent("/a"))).text()).toBe("a");

        await ServiceManager.Reload(name);

        expect(cleaned).toBe(1);
        await expect(() => router.handle(mockServiceEvent("/a"))).rejects.toMatchObject({ status: 404 });
    });

    it("wires import.meta.hot.dispose + accept to reload and re-load", async () => {
        const name = uid("hmr2");
        let cleaned = false;

        const hot = {
            data: {},
            accept: vi.fn(),
            dispose: vi.fn()
        };

        const serviceV1 = {
            name,
            cleanup: async () => {
                cleaned = true;
            },
            route: Router().GET("/v", () => new Response("v1"))
        };

        await loadService(serviceV1, { hot } as any);

        // grab dispose callback and run it
        const disposeCb = hot.dispose.mock.calls[0]?.[0];
        expect(typeof disposeCb).toBe("function");
        await disposeCb({ serviceName: name });

        expect(cleaned).toBe(true);

        // Now simulate accept callback: your implementation accepts updated module and re-loads
        const acceptCb = hot.accept.mock.calls[0]?.[0];
        expect(typeof acceptCb).toBe("function");

        const serviceV2 = { ...serviceV1, route: Router().GET("/v", () => new Response("v2")) };
        await acceptCb({ default: serviceV2 });

        // After accept, service is loaded again; resolve via gateway
        const { endpoint, access } = ServiceManager.Base(undefined, { accessKey: uid("gw") });
        access(name as any);

        const res = await endpoint.GET(mockGatewayEvent({ service: name, rest: "/v" }));
        expect(await res.text()).toBe("v2");
    });
});

describe("middleware()", () => {
    it("merges guard results in order", async () => {
        const mw1 = async () => ({ a: 1 });
        const mw2 = async () => ({ b: 2 });

        const handler = async ({ guard }: any) => new Response(JSON.stringify(guard));

        const wrapped = middleware(handler, mw1 as any, mw2 as any);
        const res = await wrapped(mockServiceEvent("/"));

        expect(await res.json()).toEqual({ a: 1, b: 2 });
    });

    it("short-circuits on thrown Response", async () => {
        const mw = async () => {
            throw new Response("nope", { status: 401 });
        };
        const handler = vi.fn(async () => new Response("ok"));

        const wrapped = middleware(handler as any, mw as any);
        const res = await wrapped(mockServiceEvent("/"));

        expect(res.status).toBe(401);
        expect(await res.text()).toBe("nope");
        expect(handler).not.toHaveBeenCalled();
    });

    it("uses middleware error handlers and recursive error resolution", async () => {
        const handler = vi.fn(async () => new Response("ok"));
        const wrapped = middleware(
            handler as any,
            ((event: any) => {
                event.errorHandlers.push(() => {
                    throw () => new Response("handled", { status: 409 });
                });
                throw new Error("boom");
            }) as any
        );

        const res = await wrapped(mockServiceEvent("/"));

        expect(res.status).toBe(409);
        expect(await res.text()).toBe("handled");
        expect(handler).not.toHaveBeenCalled();
    });

    it("runs error handlers for final handler failures", async () => {
        const wrapped = middleware(
            (() => {
                throw new Error("handler failed");
            }) as any,
            ((event: any) => {
                event.errorHandlers.push((err: any) => new Response(err.message, { status: 500 }));
            }) as any
        );

        const res = await wrapped(mockServiceEvent("/"));
        expect(res.status).toBe(500);
        expect(await res.text()).toBe("handler failed");
    });

    it("rethrows SvelteKit errors and redirects", async () => {
        const httpErrorWrapped = middleware(
            (() => new Response("ok")) as any,
            (() => {
                throw skError(403, { message: "Forbidden" });
            }) as any
        );
        const redirectWrapped = middleware(
            (() => new Response("ok")) as any,
            (() => {
                throw skRedirect(302, "/login");
            }) as any
        );

        await expect(() => httpErrorWrapped(mockServiceEvent("/"))).rejects.toMatchObject({ status: 403 });
        await expect(() => redirectWrapped(mockServiceEvent("/"))).rejects.toMatchObject({ status: 302, location: "/login" });
    });
});

describe("client Service()", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("builds correct URL and parses json", async () => {
        globalThis.fetch = vi.fn(async () => {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }) as any;

        const svc = ClientService("ping" as any, { entryPoint: "/api/v1/services" });
        const out = await svc.call("/health");

        expect(out).toEqual({ ok: true });
        expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/services/ping/health", expect.any(Object));
    });

    it("includes current search params in route when config.url is available", () => {
        const svc = ClientService("ping" as any, {
            entryPoint: "/api/v1/services",
            url: new URL("https://example.test/dashboard?foo=bar&baz=1")
        });

        expect(svc.route("/health", { includeSearchParams: true })).toBe("/api/v1/services/ping/health?foo=bar&baz=1");
    });

    it("does not append search params when includeSearchParams is enabled without config.url", () => {
        const svc = ClientService("ping" as any, { entryPoint: "/api/v1/services" });

        expect(svc.route("/health", { includeSearchParams: true })).toBe("/api/v1/services/ping/health");
    });

    it("merges path search params with current search params using a single query delimiter", () => {
        const svc = ClientService("ping" as any, {
            entryPoint: "/api/v1/services",
            url: new URL("https://example.test/dashboard?foo=bar&baz=1")
        });

        expect(svc.route("/health?local=1", { includeSearchParams: true })).toBe("/api/v1/services/ping/health?local=1&foo=bar&baz=1");
    });

    it("preserves relative entrypoints when appending current search params", () => {
        const svc = ClientService("ping" as any, {
            entryPoint: "api/v1/services",
            url: new URL("https://example.test/dashboard?foo=bar")
        });

        expect(svc.route("/health", { includeSearchParams: true })).toBe("api/v1/services/ping/health?foo=bar");
    });

    it("resolves dynamic entrypoint params", () => {
        const svc = ClientService("ping" as any, {
            entryPoint: "/api/[tenant]/services/[...rest]",
            params: { tenant: "acme", rest: "v1" } as any
        });

        expect(svc.entryPoint).toBe("/api/acme/services/v1/ping");
    });

    it("throws when dynamic entrypoint params are missing", () => {
        expect(() => ClientService("ping" as any, { entryPoint: "/api/[tenant]/services" })).toThrow();
        expect(() =>
            ClientService("ping" as any, {
                entryPoint: "/api/[tenant]/services/[missing]",
                params: { tenant: "acme" } as any
            })
        ).toThrow();
    });

    it("auto JSON-encodes object body and sets content-type", async () => {
        globalThis.fetch = vi.fn(async (_url: any, init: any) => {
            expect(init.method).toBe("POST");
            expect(init.headers["content-type"]).toBe("application/json");
            expect(init.body).toBe(JSON.stringify({ x: 1 }));
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }) as any;

        const svc = ClientService("ping" as any, { entryPoint: "/api/v1/services" });
        await svc.call("/echo", { x: 1 });
    });

    it("throws ServiceError and parses json error bodies", async () => {
        globalThis.fetch = vi.fn(async () => {
            return new Response(JSON.stringify({ message: "nope" }), {
                status: 403,
                statusText: "Forbidden",
                headers: { "content-type": "application/json" }
            });
        }) as any;

        const svc = ClientService("ping" as any, { entryPoint: "/api/v1/services" });

        try {
            await svc.call("/forbidden");
            throw new Error("expected throw");
        } catch (e: any) {
            // ServiceError.Check throws ServiceError.Create(res) (async), so we might get a Promise in older implementations.
            const err = e instanceof Promise ? await e : e;
            expect(err).toBeInstanceOf(ServiceError);
            expect(err.code).toBe(403);
            expect(err.name).toBe("Forbidden");
            expect(err.data).toEqual({ message: "nope" });
        }
    });

    it("parses text error bodies and exposes response metadata", async () => {
        globalThis.fetch = vi.fn(async () => {
            return new Response("plain nope", {
                status: 500,
                statusText: "Broken",
                headers: { "content-type": "text/plain" }
            });
        }) as any;

        const svc = ClientService("ping" as any, { entryPoint: "/api/v1/services" });

        try {
            await svc.call("/broken");
            throw new Error("expected throw");
        } catch (e: any) {
            const err = e instanceof Promise ? await e : e;
            expect(err).toBeInstanceOf(ServiceError);
            expect(err.code).toBe(500);
            expect(err.name).toBe("Broken");
            expect(err.response.status).toBe(500);
            expect(err.data).toBe("plain nope");
        }
    });

    it("raw() preserves caller method when serializing object bodies", async () => {
        globalThis.fetch = vi.fn(async (_url: any, init: any) => {
            expect(init.method).toBe("PUT");
            expect(init.body).toBe(JSON.stringify({ x: 2 }));
            return new Response("ok");
        }) as any;

        const svc = ClientService("ping" as any, { entryPoint: "/api/v1/services" });
        await svc.raw("/raw", { method: "PUT", body: { x: 2 } });
    });
});

describe("utils", () => {
    it("json() sets content-type and length", async () => {
        const res = json({ a: 1 });
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
        expect(await res.json()).toEqual({ a: 1 });
    });

    it("json() and text() use UTF-8 byte length", async () => {
        const jsonRes = json({ value: "é" });
        const textRes = text("é");

        expect(new TextEncoder().encode(await jsonRes.clone().text()).byteLength).toBe(Number(jsonRes.headers.get("content-length")));
        expect(new TextEncoder().encode(await textRes.clone().text()).byteLength).toBe(Number(textRes.headers.get("content-length")));
    });

    it("text() sets content-type and length", async () => {
        const res = text("hello");
        expect(res.headers.get("content-type")).toContain("text/plain");
        expect(res.headers.get("content-length")).toBe(String("hello".length));
        expect(await res.text()).toBe("hello");
    });

    it("json() handles undefined and toJSON values", async () => {
        expect(await json(undefined).json()).toBeNull();
        expect(await json({ toJSON: () => ({ value: 1 }) }).json()).toEqual({ value: 1 });
    });

    it("html(), fail() and error() set expected defaults", async () => {
        const htmlRes = html("<strong>ok</strong>");
        const failRes = fail({ bad: true });
        const errorRes = error({ broken: true });

        expect(htmlRes.headers.get("content-type")).toContain("text/html");
        expect(await htmlRes.text()).toContain("ok");
        expect(failRes.status).toBe(400);
        expect(await failRes.json()).toEqual({ bad: true });
        expect(errorRes.status).toBe(500);
        expect(await errorRes.json()).toEqual({ broken: true });
    });

    it("file() sets disposition based on mode", async () => {
        const res = file("DATA", { mode: "attachment", filename: "x.txt" } as any);
        expect(res.headers.get("content-disposition")).toContain("attachment");
    });

    it("file() supports inline disposition with optional filename", async () => {
        const unnamed = file("DATA", { mode: "inline", contentType: "text/plain" });
        const named = file("DATA", { mode: "inline", contentType: "text/plain", filename: "view.txt" });

        expect(unnamed.headers.get("content-type")).toBe("text/plain");
        expect(unnamed.headers.has("content-disposition")).toBe(false);
        expect(named.headers.get("content-disposition")).toContain("inline");
    });

    it("file() encodes unsafe filenames in Content-Disposition", async () => {
        const res = file("DATA", { mode: "attachment", filename: "r\u00e9port\";\r\nx=.txt" } as any);
        const disposition = res.headers.get("content-disposition") ?? "";

        expect(disposition).toContain("filename=");
        expect(disposition).toContain("filename*=UTF-8''");
        expect(disposition).not.toContain("\r");
        expect(disposition).not.toContain("\n");
        expect(disposition).not.toContain('r\u00e9port"');
    });
});

describe("ServiceManager.Internal", () => {
    it("calls local functions and returns local values", async () => {
        const fn = uid("local-fn");
        const value = uid("local-value");
        await loadService({ name: fn, local: (input: string) => `hello-${input}` });
        await loadService({ name: value, local: { ready: true } });

        expect(ServiceManager.Internal(fn as any, "world" as any)).toBe("hello-world");
        expect(ServiceManager.Internal(value as any)).toEqual({ ready: true });
    });

    it("throws for missing services and services without local handlers", async () => {
        const name = uid("route-only");
        await loadService({ name, route: Router().GET("/", () => new Response("ok")) });

        expect(() => ServiceManager.Internal(uid("missing") as any)).toThrow("not found");
        expect(() => ServiceManager.Internal(name as any)).toThrow("no local handler");
    });
});

describe("WebHTTPServer (Server)", () => {
    it("pins generated request URLs to the configured origin", () => {
        const server = new Server({
            request: () => new Response("ok"),
            origin: "https://trusted.example",
            allowedHosts: ["gateway.example"]
        }) as any;

        const request = server.toWebRequest({
            method: "GET",
            socket: {},
            headers: { host: "gateway.example" },
            url: "http://attacker.example/health?x=1"
        });

        expect(request.url).toBe("https://trusted.example/health?x=1");
    });

    it("rejects malformed and disallowed Host headers", () => {
        const server = new Server({
            request: () => new Response("ok"),
            allowedHosts: ["good.example"]
        }) as any;

        expect(() =>
            server.toWebRequest({
                method: "GET",
                socket: {},
                headers: { host: "bad example" },
                url: "/"
            })
        ).toThrow("Invalid Host header");

        expect(() =>
            server.toWebRequest({
                method: "GET",
                socket: {},
                headers: { host: "evil.example" },
                url: "/"
            })
        ).toThrow("not allowed");
    });

    it("sets safer cookie defaults", () => {
        const setCookies: string[] = [];
        const server = new Server({ request: () => new Response("ok") });
        const event = server.toRequestEvent(new Request("https://example.test/"), {
            getClientAddress: () => "127.0.0.1",
            setHeader: () => {},
            pushSetCookie: (value) => setCookies.push(value)
        });

        event.cookies.set("sid", "abc", { path: "/" });

        expect(setCookies[0]).toContain("HttpOnly");
        expect(setCookies[0]).toContain("SameSite=Lax");
        expect(setCookies[0]).toContain("Secure");
    });

    it("supports cookie read, serialize, delete and explicit overrides", () => {
        const setCookies: string[] = [];
        const server = new Server({ request: () => new Response("ok") });
        const event = server.toRequestEvent(new Request("http://localhost/?x=1", {
            headers: { cookie: "a=1; b=2" }
        }), {
            getClientAddress: () => "127.0.0.1",
            setHeader: () => {},
            pushSetCookie: (value) => setCookies.push(value)
        });

        expect(event.cookies.get("a")).toBe("1");
        expect(event.cookies.getAll()).toContainEqual({ name: "b", value: "2" });
        expect(event.cookies.serialize("x", "y", { path: "/" })).toBe("x=y; Path=/");

        event.cookies.set("sid", "abc", { path: "/", httpOnly: false, secure: false, sameSite: "strict" });
        event.cookies.delete("sid", { path: "/" });

        expect(setCookies[0]).not.toContain("HttpOnly");
        expect(setCookies[0]).toContain("SameSite=Strict");
        expect(setCookies[1]).toContain("Max-Age=0");
    });

    it("serves requests through the standalone HTTP adapter", async () => {
        const server = new Server({
            request: async (event) => {
                event.setHeaders({ "x-event": "set" });
                event.cookies.set("sid", "abc", { path: "/" });
                return new Response(await event.request.text(), {
                    status: 202,
                    headers: { "x-response": event.getClientAddress() ? "set" : "missing" }
                });
            },
            allowedHosts: ["127.0.0.1", "localhost"]
        });

        try {
            await new Promise<void>((resolve) => (server as any).listen(0, "127.0.0.1", () => resolve()));
            const address = server.address() as any;
            const res = await fetch(`http://127.0.0.1:${address.port}/submit`, {
                method: "POST",
                body: "payload"
            });

            expect(res.status).toBe(202);
            expect(res.headers.get("x-event")).toBe("set");
            expect(res.headers.get("x-response")).toBe("set");
            expect(res.headers.get("set-cookie")).toContain("sid=abc");
            expect(await res.text()).toBe("payload");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("serves routers and normalizes SvelteKit errors in the standalone HTTP adapter", async () => {
        const server = new Server({
            router: Router()
                .GET("/ok", () => new Response("ok"))
                .GET("/fail", () => {
                    throw skError(400, { message: "bad" });
                })
                .GET("/go", () => {
                    throw skRedirect(302, "/elsewhere");
                }),
            allowedHosts: ["127.0.0.1"]
        });

        try {
            await new Promise<void>((resolve) => (server as any).listen(0, "127.0.0.1", () => resolve()));
            const address = server.address() as any;
            const base = `http://127.0.0.1:${address.port}`;

            expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");

            const failRes = await fetch(`${base}/fail`);
            expect(failRes.status).toBe(400);
            expect(await failRes.json()).toEqual({ message: "bad" });

            const redirectRes = await fetch(`${base}/go`, { redirect: "manual" });
            expect(redirectRes.status).toBe(302);
            expect(redirectRes.headers.get("location")).toBe("/elsewhere");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

describe("WebProxyServer (Proxy)", () => {
    it("adapts a Node-style RequestListener to a Fetch Response", async () => {
        const listener = (req: any, res: any) => {
            if (req.url === "/x") {
                res.statusCode = 201;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true }));
            } else {
                res.statusCode = 404;
                res.end("nope");
            }
        };

        const proxy = new Proxy(listener as any);

        const res = await proxy.handle(new Request("http://local/x", { method: "GET" }));
        expect(res.status).toBe(201);
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(await res.json()).toEqual({ ok: true });
    });

    it("streams request bodies into Node-style listeners", async () => {
        const proxy = new Proxy(((req: any, res: any) => {
            let body = "";
            req.on("data", (chunk: Buffer) => {
                body += chunk.toString("utf8");
            });
            req.on("end", () => {
                res.statusCode = 200;
                res.end(`${req.method}:${req.url}:${body}`);
            });
        }) as any);

        const res = await proxy.handle(new Request("http://local/post?q=1", {
            method: "POST",
            body: "payload"
        }));

        expect(await res.text()).toBe("POST:/post?q=1:payload");
    });

    it("preserves response headers, cookies and null-body statuses", async () => {
        const proxy = new Proxy(((_req: any, res: any) => {
            res.statusCode = 204;
            res.setHeader("x-test", "ok");
            res.setHeader("set-cookie", ["a=1", "b=2"]);
            res.end("ignored");
        }) as any);

        const res = await proxy.handle(new Request("http://local/empty"));

        expect(res.status).toBe(204);
        expect(res.headers.get("x-test")).toBe("ok");
        expect(res.headers.get("set-cookie")).toContain("a=1");
        expect(await res.text()).toBe("");
    });

    it("rejects when the listener emits an error", async () => {
        const proxy = new Proxy(((_req: any, res: any) => {
            res.emit("error", new Error("listener failed"));
        }) as any);

        await expect(() => proxy.handle(new Request("http://local/error"))).rejects.toThrow("listener failed");
    });

    it("supports common Server interface methods and events", async () => {
        const proxy = new Proxy(undefined as any);
        const upgrade = vi.fn();
        const timeout = vi.fn();
        const closed = vi.fn();

        proxy.on("upgrade", upgrade as any);
        proxy.setTimeout(50, timeout as any);
        proxy.on("close", closed);

        proxy.handleUpgrade({ url: "/ws" } as any, {} as any, Buffer.from(""));
        proxy.emit("timeout");

        await new Promise<void>((resolve) => proxy.getConnections((_err, count) => {
            expect(count).toBe(0);
            resolve();
        }));

        await new Promise<void>((resolve) => proxy.close(() => resolve()));

        expect(proxy.address()).toEqual({ port: 80, family: "IPv4", address: "127.0.0.1" });
        expect(proxy.listen()).toBe(proxy);
        expect(proxy.ref()).toBe(proxy);
        expect(proxy.unref()).toBe(proxy);
        expect(proxy[Symbol.asyncDispose]()).resolves.toBeUndefined();
        proxy.closeAllConnections();
        proxy.closeIdleConnections();
        expect(upgrade).toHaveBeenCalled();
        expect(timeout).toHaveBeenCalled();
        expect(closed).toHaveBeenCalled();
    });

    it("supports response header mutation methods used by middleware", async () => {
        const proxy = new Proxy(((_req: any, res: any) => {
            res.setHeader("x-remove", "gone");
            expect(res.hasHeader("x-remove")).toBe(true);
            res.removeHeader("x-remove");
            expect(res.hasHeader("x-remove")).toBe(false);

            res.appendHeader("x-many", "a");
            res.appendHeader("x-many", ["b", "c"]);
            expect(res.getHeader("x-many")).toEqual(["a", "b", "c"]);
            expect(res.getHeaderNames()).toContain("x-many");
            expect(res.getHeaders()["x-many"]).toEqual(["a", "b", "c"]);

            res.writeContinue(() => undefined);
            res.writeEarlyHints({ link: "</style.css>" }, () => undefined);
            res.writeProcessing();
            res.addTrailers({ expires: "never" });
            res.assignSocket({} as any);
            res.detachSocket({} as any);

            res.writeHead(202, "Accepted", { "content-type": "text/plain" });
            res.write("hello ");
            res.end("world");
        }) as any);

        const res = await proxy.handle(new Request("http://local/headers"));

        expect(res.status).toBe(202);
        expect(res.statusText).toBe("Accepted");
        expect(res.headers.get("x-many")).toContain("a");
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(await res.text()).toBe("hello world");
    });
});
