import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    json,
    text,
    // (html is mentioned in README; add it once implemented in utils.ts)
    file
} from "../src/lib/server/index.js";

import { Service as ClientService, ServiceError } from "../src/lib/client/index.js";
import * as devalue from "devalue";

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

    // it("throws 404 on unknown route", async () => {
    //     const router = Router().GET("/ok", () => new Response("ok"));
    //
    //     expect(router.handle(mockServiceEvent("/nope"))).rejects.satisfies((input: any) => {
    //         return input.status === 404
    //     });
    // });
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
});

describe("ServiceManager.Load HMR integration", () => {
    // it("calls cleanup + resets router on Reload", async () => {
    //     const name = uid("hmr");
    //     let cleaned = 0;
    //
    //     const router = Router().GET("/a", () => new Response("a"));
    //
    //     await loadService({
    //         name,
    //         route: router,
    //         cleanup: async () => {
    //             cleaned++;
    //         }
    //     });
    //
    //     // sanity: route exists
    //     const res1 = await router.handle(mockServiceEvent("/a"));
    //     expect(await res1.text()).toBe("a");
    //
    //     await ServiceManager.Reload(name);
    //
    //     expect(cleaned).toBe(1);
    //     // router should be reset (no route now)
    //     await expect(() => router.handle(mockServiceEvent("/a"))).rejects.toMatchObject({ status: 404 });
    // });

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

    // it("short-circuits on thrown Response", async () => {
    //     const mw = async () => {
    //         throw new Response("nope", { status: 401 });
    //     };
    //     const handler = vi.fn(async () => new Response("ok"));
    //
    //     const wrapped = middleware(handler as any, mw as any);
    //     const res = await wrapped(mockServiceEvent("/"));
    //
    //     expect(res.status).toBe(401);
    //     expect(handler).not.toHaveBeenCalled();
    // });
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
});

describe("utils", () => {
    it("json() sets content-type and length", async () => {
        const res = json({ a: 1 });
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
        expect(await res.json()).toEqual({ a: 1 });
    });

    it("text() sets content-type and length", async () => {
        const res = text("hello");
        expect(res.headers.get("content-type")).toContain("text/plain");
        expect(res.headers.get("content-length")).toBe(String("hello".length));
        expect(await res.text()).toBe("hello");
    });

    it("file() sets disposition based on mode", async () => {
        const res = file("DATA", { mode: "attachment", filename: "x.txt" } as any);
        expect(res.headers.get("content-disposition")).toContain("attachment");
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
});
