import {
    error,
    type Action as SVAction,
    type RequestEvent,
    type RequestHandler,
    isHttpError,
    isRedirect
} from '@sveltejs/kit';

import {stringify} from 'devalue';
import {WebHTTPServer} from '$lib/server/helpers/WebHTTPServer.js';
import {WebProxyServer} from '$lib/server/helpers/WebProxyServer.js';
import {middleware as mWare} from '$lib/server/helpers/middleware.js';

type MaybePromise<T> = T | Promise<T>;

type ViteImportMeta = ImportMeta & {
    hot?: {
        data: any;
        accept(cb?: (mod: any) => void): void;
        dispose(cb: (data: any) => void): void;
        prune?(cb: (data: any) => void): void;
    };
};

/**
 * Supported HTTP methods for routing and endpoint exposure.
 */
export type RequestMethods = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD' | 'PATCH' | 'OPTIONS';

/**
 * Strict path parameter extractor for route strings:
 * - `[param]`     => string
 * - `[...param]`  => string (catch-all returned as a single string; user may split)
 * - `[[param]]`   => treated as string (optional syntax but required for typing)
 */
export type ExtractPathParams<T extends string> = T extends `/${infer Segment}/${infer Rest}`
    ? MergeParams<ExtractSegmentParam<Segment>, ExtractPathParams<`/${Rest}`>>
    : T extends `/${infer Segment}`
        ? ExtractSegmentParam<Segment>
        : {};

export type ExtractSegmentParam<S extends string> = S extends `[...${infer Param}]`
    ? { [K in Param]: string }
    : S extends `[[${infer Param}]]`
        ? { [K in Param]: string } // treat optional as required
        : S extends `[${infer Param}]`
            ? { [K in Param]: string }
            : {};

export type MergeParams<A, B> = A & B;

/**
 * A route handler receives an enhanced request event and returns a Response.
 */
export type RouteHandler<Path extends string> = (
    event: ServiceRequestEvent<RequestEvent['params'] & ExtractPathParams<Path>, Path>
) => MaybePromise<Response>;

// @ts-ignore
export type ActionHandler<
    Path extends string,
    OutputData extends Record<string, any> = Record<string, any>
    // @ts-ignore
> = SVAction<ExtractPathParams<Path>, OutputData, Path>;

/**
 * Internal route definition used by {@link ServiceRouter}.
 */
export interface Route<Path extends string> {
    readonly path: Path;
    readonly isAction: boolean;
    readonly regex: RegExp;
    readonly paramNames: ReadonlyArray<string>;
    readonly handler: RouteHandler<Path>;
    readonly method: RequestMethods;
    readonly isCatchAll: boolean;
    readonly isOptional: boolean;
    readonly priority: number; // higher = more specific
}

/**
 * Nested router definition used by {@link ServiceRouter.use}.
 */
interface NestedRouter {
    readonly prefix: string;
    readonly router: ServiceRouter;
    readonly regex: RegExp;
    readonly paramNames: ReadonlyArray<string>;
    readonly isCatchAll: boolean;
    readonly isOptional: boolean;
    readonly priority: number;
}

/**
 * A service handler (either a function router or per-method map) receives a {@link ServiceRequestEvent}.
 */
export type ServiceHandler<
    Params extends Record<string, string> = Record<string, string>,
    RouteId extends string | null = string | null
> = (event: ServiceRequestEvent<Params, RouteId>) => MaybePromise<Response>;

/**
 * Enhanced RequestEvent passed into service handlers.
 *
 * Adds `route.base`, `route.service` and a rewritten `url` that points at the service-relative path.
 */
export interface ServiceRequestEvent<
    Params extends Record<string, string | string[] | undefined> = Record<string, string>,
    RouteId extends string | null = string | null
    // @ts-ignore
> extends Omit<RequestEvent<any, RouteId>, 'params'> {
    readonly params: Params;
    readonly route: {
        readonly id: RouteId;
        readonly base: string;
        readonly service: string;
        readonly serviceURL: URL;
        readonly baseURL: URL;
        readonly originalURL: URL;
    };
}

/**
 * Object returned by {@link ServiceManager.Base}.
 */
export interface ServiceEndpoint {
    /**
     * Restrict gateway access to only these service names.
     *
     * Calling access() replaces the current allow-list.
     */
    access(...keys: (keyof App.Services)[]): void;

    /**
     * SvelteKit RequestHandlers mapped by HTTP method.
     */
    readonly endpoint: Record<RequestMethods, RequestHandler>;
}

/**
 * Service definition used by {@link ServiceManager.Load}.
 */
export interface Service<
    T extends string = string,
    Args extends readonly unknown[] = readonly unknown[],
    L = unknown
> {
    readonly name: T;
    readonly local?: ((...args: Args) => L) | L;
    readonly route?: Partial<Record<RequestMethods, ServiceHandler>> | ServiceRouter | ServiceHandler;
    readonly load?: () => MaybePromise<void>;
    readonly cleanup?: () => MaybePromise<void>;
    readonly dependsOn?: ReadonlyArray<keyof App.Services>;
}

/**
 * Internal service error used to translate failures to HTTP errors.
 */
class ServiceError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly data?: unknown
    ) {
        super(message);
        this.name = 'ServiceError';
    }
}

/**
 * Helper type to produce readable compile-time errors for Service.Local access.
 */
type ErrorMessage<T extends string> = {
    readonly error: T;
    readonly __brand: never;
};

export type ServiceLocalParameters<T extends keyof App.Services> = App.Services[T] extends {
        local: (...args: infer Args) => any;
    }
    ? Args
    : readonly [];

export type ServiceLocalReturn<T extends keyof App.Services> = App.Services[T] extends {
        local: (...args: any[]) => infer R;
    }
    ? R
    : App.Services[T] extends { local: infer L }
        ? L
        : ErrorMessage<`Service '${T}' does not have a local function defined`>;

/**
 * Cache for compiled path regexes to avoid repeated parsing.
 */
const pathRegexCache = new Map<
    string,
    {
        regex: RegExp;
        paramNames: string[];
        isCatchAll: boolean;
        isOptional: boolean;
        priority: number;
    }
>();

/**
 * Compile a path string (e.g. `/users/[id]`) into a regex + param metadata.
 *
 * Catch-all segments return a single captured string (user can split if desired).
 */
const createPathRegex = <Path extends string>(path: Path) => {
    const cached = pathRegexCache.get(path);
    if (cached) return cached;

    const paramNames: string[] = [];
    let isCatchAll = false;
    let isOptional = false;

    const segments = path.split('/').filter(Boolean);
    const priority = segments.reduce((acc, segment) => {
        if (segment.startsWith('[...')) return acc - 10;
        if (segment.startsWith('[[') && segment.endsWith(']]')) return acc - 5;
        if (segment.startsWith('[')) return acc - 1;
        return acc + 1;
    }, 0);

    let regexString = '';
    const parts = path.split('/').filter(Boolean);

    for (const part of parts) {
        if (part.startsWith('[...') && part.endsWith(']')) {
            isCatchAll = true;
            const paramName = part.slice(4, -1);
            paramNames.push(paramName);
            regexString += '/(.+)';
        } else if (part.startsWith('[[') && part.endsWith(']]')) {
            isOptional = true;
            const paramName = part.slice(2, -2);
            paramNames.push(paramName);
            regexString += '(?:/([^/]*))?';
        } else if (part.startsWith('[') && part.endsWith(']')) {
            const paramName = part.slice(1, -1);
            paramNames.push(paramName);
            regexString += '/([^/]+)';
        } else {
            regexString += '/' + part.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        }
    }

    const result = {
        regex: new RegExp(`^${regexString}/?$`),
        paramNames,
        isCatchAll,
        isOptional,
        priority
    };

    pathRegexCache.set(path, result);
    return result;
};

/**
 * A minimal, fast router for service-relative routing.
 *
 * Optimizations:
 * - Routes are indexed per method (avoids scanning non-matching methods)
 * - Routes and nested routers are sorted once on mutation (not per request)
 * - Param extraction uses stored match + metadata (no extra regex compile per match)
 */
export class ServiceRouter {
    private _routes: Route<any>[] = [];
    private _nestedRouters: NestedRouter[] = [];

    private routesSorted = false;
    private nestedSorted = false;

    private routesByMethod: Record<RequestMethods, Route<any>[]> = {
        GET: [],
        PUT: [],
        POST: [],
        DELETE: [],
        HEAD: [],
        PATCH: [],
        OPTIONS: []
    };

    /**
     * @warning Dangerous read-only access. Do not mutate.
     * The router relies on these objects for matching requests.
     */
    get routes(): readonly Route<any>[] {
        return this._routes;
    }

    /**
     * @warning Dangerous read-only access. Do not mutate.
     * Nested routers are used for prefix dispatch.
     */
    get nestedRouters(): readonly NestedRouter[] {
        return this._nestedRouters;
    }

    /** Register a GET handler. */
    GET<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('GET', path, handler);
    }

    /** Register a PUT handler. */
    PUT<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('PUT', path, handler);
    }

    /** Register a POST handler. */
    POST<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('POST', path, handler);
    }

    /** Register a PATCH handler. */
    PATCH<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('PATCH', path, handler);
    }

    /** Register a DELETE handler. */
    DELETE<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('DELETE', path, handler);
    }

    /** Register a HEAD handler. */
    HEAD<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('HEAD', path, handler);
    }

    /** Register an OPTIONS handler. */
    OPTIONS<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('OPTIONS', path, handler);
    }

    /**
     * Remove routes or nested routers.
     *
     * - If `method` is omitted: removes the nested router with this prefix AND all routes with this exact path.
     * - If `method` is provided: removes only the route with this exact path+method.
     */
    discard(path_or_prefix: string, method?: RequestMethods): this {
        if (!method) {
            this._nestedRouters = this._nestedRouters.filter(({prefix}) => path_or_prefix !== prefix);
            this.nestedSorted = false;
        }

        // Correct removal logic: remove only items matching the selector (path + optional method)
        const beforeLen = this._routes.length;
        this._routes = this._routes.filter(
            (r) => !(r.path === path_or_prefix && (!method || r.method === method))
        );

        if (this._routes.length !== beforeLen) {
            this.rebuildMethodIndex();
            this.routesSorted = false;
        }

        return this;
    }

    /**
     * Mount a nested router under a prefix.
     *
     * Prefix supports dynamic segments (e.g. `/users/[id]`).
     */
    use<Prefix extends string>(prefix: Prefix, router: ServiceRouter): this {
        const normalizedPrefix = this.normalizePrefix(prefix);
        const prefixRegex = this.createPrefixRegex(normalizedPrefix);

        this._nestedRouters.push({
            prefix: normalizedPrefix,
            router,
            regex: prefixRegex.regex,
            paramNames: prefixRegex.paramNames,
            isCatchAll: prefixRegex.isCatchAll,
            isOptional: prefixRegex.isOptional,
            priority: prefixRegex.priority
        });

        this.nestedSorted = false;
        return this;
    }

    /**
     * Register a SvelteKit `Action`-style handler under POST, returning an Action JSON Response.
     */
    action<Path extends string, OutputData extends Record<string, any> = Record<string, any>>(
        path: Path,
        handler: ActionHandler<Path, OutputData>
    ): this {
        return this.addHandler(
            'POST',
            path,
            async (event) => {
                try {
                    // Extract params for the declared action route
                    const {regex, paramNames, isCatchAll} = createPathRegex(path);
                    const match = event.url.pathname.match(regex);
                    const params = match
                        ? this.extractParamsFromMatchMeta({paramNames, isCatchAll}, match)
                        : {};

                    const enhancedEvent = {
                        ...event,
                        params: {...event.params, ...params},
                        route: {...event.route, id: path}
                    } as ServiceRequestEvent<any, Path>;

                    const result = await handler(enhancedEvent as any);
                    return this.formatActionResult(result);
                } catch (err) {
                    return this.handleActionError(err);
                }
            },
            true
        );
    }

    /**
     * Register one handler for all HTTP methods.
     */
    USE<Path extends string>(path: Path, handler: RouteHandler<Path>, methods: RequestMethods[] = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']): this {
        for (const method of methods) this.addHandler(method, path, handler);
        return this;
    }

    /**
     * Handle a service-relative request by matching nested routers first, then local routes.
     */
    public handle(event: ServiceRequestEvent): MaybePromise<Response> {
        const {url, request} = event;
        const method = request.method as RequestMethods;

        // Use the already processed service path from createServiceRequest
        const path = this.normalizePath(event.route.service || url.pathname);

        // Check nested routers first
        const nestedResponse = this.handleNestedRouters(event, path);
        if (nestedResponse) return nestedResponse;

        // Sort route lists once if needed
        if (!this.routesSorted) this.sortRoutes();

        return this.handleLocalRoutes(event, method, path);
    }

    /**
     * Remove all registered routes and nested routers.
     * Useful for HMR to prevent stale route handlers from remaining registered.
     */
    public reset(): this {
        this._routes = [];
        this._nestedRouters = [];

        // Clear indexes
        this.routesByMethod = {
            GET: [],
            PUT: [],
            POST: [],
            DELETE: [],
            HEAD: [],
            PATCH: [],
            OPTIONS: []
        };

        // No routes/routers exist, so "sorted" is trivially true
        this.routesSorted = true;
        this.nestedSorted = true;

        return this;
    }

    /**
     * Add a new route handler to the router.
     */
    private addHandler<Path extends string>(
        method: RequestMethods,
        path: Path,
        handler: RouteHandler<Path>,
        isAction: boolean = false
    ): this {
        const {regex, paramNames, isCatchAll, isOptional, priority} = createPathRegex(path);

        const route: Route<Path> = {
            method,
            path,
            regex,
            paramNames,
            handler,
            isAction,
            isCatchAll,
            isOptional,
            priority
        };

        this._routes.push(route);
        this.routesByMethod[method].push(route);

        this.routesSorted = false;
        return this;
    }

    /**
     * Rebuild the per-method index from the master route list.
     * Used after discard operations.
     */
    private rebuildMethodIndex(): void {
        this.routesByMethod = {
            GET: [],
            PUT: [],
            POST: [],
            DELETE: [],
            HEAD: [],
            PATCH: [],
            OPTIONS: []
        };
        for (const r of this._routes) this.routesByMethod[r.method].push(r);
    }

    /**
     * Sort routes by descending priority (more specific first) per method.
     */
    private sortRoutes(): void {
        for (const m of Object.keys(this.routesByMethod) as RequestMethods[]) {
            this.routesByMethod[m].sort((a, b) => b.priority - a.priority);
        }
        this.routesSorted = true;
    }

    /**
     * Sort nested routers once by descending priority (more specific prefixes first).
     */
    private sortNested(): void {
        this._nestedRouters.sort((a, b) => b.priority - a.priority);
        this.nestedSorted = true;
    }

    /**
     * Compile a prefix regex used for nested router dispatch.
     *
     * Unlike route regexes, prefix regexes are not end-anchored: they match paths that START with the prefix.
     */
    private createPrefixRegex(prefix: string) {
        const paramNames: string[] = [];
        let isCatchAll = false;
        let isOptional = false;

        const segments = prefix.split('/').filter(Boolean);
        const priority = segments.reduce((acc, segment) => {
            if (segment.startsWith('[...')) return acc - 10;
            if (segment.startsWith('[[') && segment.endsWith(']]')) return acc - 5;
            if (segment.startsWith('[')) return acc - 1;
            return acc + 1;
        }, 0);

        let regexString = '';
        const parts = prefix.split('/').filter(Boolean);

        for (const part of parts) {
            if (part.startsWith('[...') && part.endsWith(']')) {
                isCatchAll = true;
                const paramName = part.slice(4, -1);
                paramNames.push(paramName);
                // Match at least one segment for catch-all in prefix
                regexString += '/([^/]+)';
            } else if (part.startsWith('[[') && part.endsWith(']]')) {
                isOptional = true;
                const paramName = part.slice(2, -2);
                paramNames.push(paramName);
                regexString += '(?:/([^/]*))?';
            } else if (part.startsWith('[') && part.endsWith(']')) {
                const paramName = part.slice(1, -1);
                paramNames.push(paramName);
                regexString += '/([^/]+)';
            } else {
                regexString += '/' + part.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            }
        }

        return {
            regex: new RegExp(`^${regexString}(?=/|$)`),
            paramNames,
            isCatchAll,
            isOptional,
            priority
        };
    }

    /**
     * Normalize prefix input to a stable internal form.
     */
    private normalizePrefix(prefix: string): string {
        const normalized = prefix.startsWith('/') ? prefix : `/${prefix}`;
        return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
    }

    /**
     * Normalize a request path (remove trailing slash, keep `/`).
     */
    private normalizePath(path: string): string {
        return path.replace(/\/$/, '') || '/';
    }

    /**
     * Extract params from a match using route metadata (no extra regex compile).
     */
    private extractParamsFromMatch(route: Route<any>, match: RegExpMatchArray): Record<string, string> {
        return this.extractParamsFromMatchMeta(
            {paramNames: route.paramNames, isCatchAll: route.isCatchAll},
            match
        );
    }

    /**
     * Extract params from a match using metadata-only (used by actions).
     */
    private extractParamsFromMatchMeta(
        meta: { paramNames: ReadonlyArray<string>; isCatchAll: boolean },
        match: RegExpMatchArray
    ): Record<string, string> {
        const params: Record<string, string> = {};

        if (meta.isCatchAll && meta.paramNames.length === 1) {
            params[meta.paramNames[0]] = match[1] || '';
            return params;
        }

        meta.paramNames.forEach((name, index) => {
            params[name] = match[index + 1] || '';
        });

        return params;
    }

    /**
     * Attempt to dispatch the request to a nested router.
     */
    private handleNestedRouters(event: ServiceRequestEvent, path: string): MaybePromise<Response> | null {
        if (!this.nestedSorted) this.sortNested();

        for (const nestedRouter of this._nestedRouters) {
            const prefixMatch = this.matchesPrefix(path, nestedRouter);
            if (!prefixMatch) continue;

            const prefixParams = this.extractPrefixParams(nestedRouter, prefixMatch.matchedPath);
            const remainingPath = prefixMatch.remainingPath;

            const newUrl = new URL(event.url);
            newUrl.pathname = remainingPath;

            const nestedEvent: ServiceRequestEvent = {
                ...event,
                url: newUrl,
                params: {...event.params, ...prefixParams},
                route: {
                    ...event.route,
                    base: `${event.route.base}${nestedRouter.prefix}`,
                    service: remainingPath
                }
            };

            return nestedRouter.router.handle(nestedEvent);
        }

        return null;
    }

    /**
     * Check whether a path starts with a nested router's prefix regex.
     */
    private matchesPrefix(
        path: string,
        nestedRouter: NestedRouter
    ): { matchedPath: string; remainingPath: string } | null {
        const match = path.match(nestedRouter.regex);
        if (!match || match.index !== 0) return null;

        const matchedPath = match[0];
        const remainingPath = path.slice(matchedPath.length);

        const normalizedRemainingPath = remainingPath
            ? remainingPath.startsWith('/')
                ? remainingPath
                : `/${remainingPath}`
            : '/';

        return {matchedPath, remainingPath: normalizedRemainingPath};
    }

    /**
     * Extract prefix parameters from a nested router match.
     */
    private extractPrefixParams(nestedRouter: NestedRouter, matchedPath: string): Record<string, string> {
        const match = matchedPath.match(nestedRouter.regex);
        if (!match) return {};

        const params: Record<string, string> = {};

        if (nestedRouter.isCatchAll && nestedRouter.paramNames.length === 1) {
            params[nestedRouter.paramNames[0]] = match[1] || '';
            return params;
        }

        nestedRouter.paramNames.forEach((name, index) => {
            params[name] = match[index + 1] || '';
        });

        return params;
    }

    /**
     * Match and handle a local route for a given method.
     *
     * Routes are pre-indexed by method to avoid scanning irrelevant routes.
     */
    private handleLocalRoutes(
        event: ServiceRequestEvent,
        method: RequestMethods,
        path: string
    ): MaybePromise<Response> {
        const list = this.routesByMethod[method];

        for (const route of list) {
            const match = path.match(route.regex);
            if (!match) continue;

            const params = this.extractParamsFromMatch(route, match);
            const enhancedEvent = {
                ...event,
                params: {...event.params, ...params},
                route: {...event.route, id: route.path}
            } as ServiceRequestEvent;

            return route.handler(enhancedEvent as any);
        }

        throw error(404, {message: `Route not found: ${method} ${path}`});
    }

    /**
     * Convert a SvelteKit Action result to a JSON response.
     */
    private formatActionResult(result: any): Response {
        // NOTE: This mirrors your original behavior.
        if (result?.type === 'failure' && 'status' in result && result.status) {
            return Action.fail(result.status, result.data);
        }
        return Action.success(200, result ?? undefined);
    }

    /**
     * Normalize known SvelteKit error/redirect shapes into Action responses.
     */
    private handleActionError(err: unknown): Response {
        if (isHttpError(err)) {
            return Action.error(err.status, err.body);
        }
        if (isRedirect(err)) {
            return Action.redirect(err.status, err.location);
        }
        throw err;
    }

    /**
     * Convenience constructor for a new router instance.
     */
    static New(): ServiceRouter {
        return new ServiceRouter();
    }
}

/**
 * Service registry and gateway utilities.
 *
 * - Use {@link ServiceManager.Load} to register services
 * - Use {@link ServiceManager.Base} to expose the gateway handlers in a SvelteKit route
 * - Use {@link ServiceManager.Internal} to call service-local functions from server code
 */
export class ServiceManager {
    private static readonly instance = new ServiceManager();
    private readonly services = new Map<string, Service>();
    private readonly loadingPromises = new Map<string, Promise<void>>();

    private readonly accessLists = new Map<string, Set<string>>();

    private getAccessList(key: string): Set<string> {
        let set = this.accessLists.get(key);
        if (!set) {
            set = new Set<string>();
            this.accessLists.set(key, set);
        }
        return set;
    }


    private constructor() {
    }

    /**
     * Load a service definition (supports `export default` and optional HMR).
     *
     * @param service The service object or module `{ default: service }`
     * @param module Pass `import.meta` from the service file for HMR (dev only)
     */
    static async Load(
        service: MaybePromise<Service | { default: Service }>,
        module?: ViteImportMeta
    ): Promise<Service> {
        const instance = ServiceManager.instance;

        const _service = await (async () => {
            let svc = await service;
            if (svc && typeof svc === 'object' && 'default' in svc) svc = (svc as any).default;
            return svc as Service;
        })();

        // If already registered, just return (important: don't register HMR twice)
        if (instance.services.has(_service.name)) return _service;

        const loadingStack = new Set<string>();

        const loadServiceRecursively = async (svc: Service): Promise<void> => {
            if (instance.services.has(svc.name)) return;
            if (loadingStack.has(svc.name)) {
                throw new ServiceError(500, `Circular dependency detected involving service '${svc.name}'`);
            }
            loadingStack.add(svc.name);

            // Load dependencies first
            if (svc.dependsOn?.length) {
                await Promise.all(
                    svc.dependsOn.map(async (depName) => {
                        const dep = instance.services.get(depName as string);
                        if (!dep) throw new ServiceError(500, `Dependency '${String(depName)}' of service '${svc.name}' not found`);
                        await loadServiceRecursively(dep);
                    })
                );
            }

            // Load this service
            if (svc.load && !instance.loadingPromises.has(svc.name)) {
                const loadPromise = Promise.resolve(svc.load())
                    .catch((error) => {
                        console.error(`Failed to load service '${svc.name}':`, error);
                        throw new ServiceError(500, `Service '${svc.name}' failed to load`);
                    })
                    .finally(() => {
                        instance.loadingPromises.delete(svc.name);
                        loadingStack.delete(svc.name);
                    });

                instance.loadingPromises.set(svc.name, loadPromise);
                await loadPromise;
            }

            instance.services.set(svc.name, svc);
        };

        await loadServiceRecursively(_service);

        // -------------------------
        // ✅ Vite HMR integration
        // -------------------------
        const hot = module?.hot;
        if (hot) {
            // Store the service name in hot data so disposal can clean it
            hot.data.serviceName = _service.name;

            // When this module is replaced, always cleanup + unregister routes
            hot.dispose(async (data: any) => {
                const name = data?.serviceName as string | undefined;
                if (name) await ServiceManager.Reload(name);
            });

            // When the module updates, accept it and re-load the updated default export
            hot.accept(async (newModule: any) => {
                // newModule is the updated module namespace (or undefined)
                await ServiceManager.Reload(_service.name);

                const next = newModule?.default ?? newModule;
                // Support either:
                //  - export default await ServiceManager.Load(...)
                //  - export default ServiceManager.Load(...).finally(...)
                //  - export default { name, route, ... }
                await ServiceManager.Load(next, module);
            });
        }

        return _service;
    }


    /**
     * Reload a service during HMR:
     * - Runs cleanup() if present
     * - Removes service from registry
     */
    static async Reload(name: string): Promise<void> {
        const instance = ServiceManager.instance;
        const service = instance.services.get(name);
        if (!service) return;

        // cleanup hook
        if (service.cleanup) {
            try {
                await service.cleanup();
            } catch (err) {
                console.warn(`Cleanup for service '${name}' failed:`, err);
            }
        }

        // unregister router routes (critical for HMR)
        if (service.route instanceof ServiceRouter) {
            try {
                service.route.reset();
            } catch (err) {
                console.warn(`Failed to reset router for service '${name}':`, err);
            }
        }

        instance.services.delete(name);
        instance.loadingPromises.delete(name);

        console.debug(`[ServiceManager] Unregistered service: ${name}`);
    }


    /**
     * Helpers to select a service name from params or querystring.
     */
    static readonly ServiceSelector = {
        params: (name: string = 'service_name') => (event: RequestEvent): Service => {
            // @ts-ignore
            const serviceName = event.params[name];
            if (!serviceName) throw error(400, {message: `Service parameter '${name}' is required`});

            const service = ServiceManager.instance.services.get(serviceName);
            if (!service) throw error(404, {message: `Service '${serviceName}' not found`});

            return service;
        },
        query: (name: string = 'service_name') => (event: RequestEvent): Service => {
            const serviceName = event.url.searchParams.get(name);
            if (!serviceName) throw error(400, {message: `Service query parameter '${name}' is required`});

            const service = ServiceManager.instance.services.get(serviceName);
            if (!service) throw error(404, {message: `Service '${serviceName}' not found`});

            return service;
        }
    };

    /**
     * Create a gateway endpoint for SvelteKit route files.
     *
     * Example usage:
     * ```ts
     * const { endpoint, access } = ServiceManager.Base();
     * export const { GET, POST, PUT, DELETE, PATCH, HEAD } = endpoint;
     * access('ping');
     * ```
     *
     * @param serviceSelector Select the service from params/query. Defaults to `[service_name]` param.
     * @param options
     */
    static Base(
        serviceSelector: (event: RequestEvent) => MaybePromise<Service> =
        ServiceManager.ServiceSelector.params('service_name'),
        options?: { accessKey?: string }
    ): ServiceEndpoint {
        const instance = ServiceManager.instance;

        // A stable key so HMR recreations don't create disconnected allowlists
        const key = options?.accessKey ?? 'default';

        // IMPORTANT: not a closure Set — it lives on the singleton
        const accessList = instance.getAccessList(key);

        const handle: RequestHandler = async (event) => {
            try {
                const service = await serviceSelector(event);

                if (!accessList.has(service.name)) throw error(403, {message: `Service '${service.name}' is not accessible`});

                if (!service.route) throw error(503, {message: `Service '${service.name}' has no route handler`});

                const serviceRequest = ServiceManager.createServiceRequest(event);

                if (service.route instanceof ServiceRouter) return await service.route.handle(serviceRequest);

                if (typeof service.route === 'function') return await service.route(serviceRequest);

                const handler = service.route[event.request.method as RequestMethods];
                if (!handler) throw error(405, {message: `Method ${event.request.method} not allowed`});

                return await handler(serviceRequest);
            } catch (err) {
                if (err instanceof ServiceError) throw error(err.status, {message: err.message});
                throw err;
            }
        };

        const endpoint: Record<RequestMethods, RequestHandler> = {
            GET: handle,
            PUT: handle,
            POST: handle,
            DELETE: handle,
            HEAD: handle,
            PATCH: handle,
            OPTIONS: handle
        };

        return {
            access: (...keys: (keyof App.Services)[]): void => {
                accessList.clear();
                keys.forEach(k => accessList.add(k as string));
            },
            endpoint
        };
    }

    /**
     * Convert a gateway RequestEvent into a service-relative {@link ServiceRequestEvent}.
     *
     * This method rewrites `event.url.pathname` so that service routers see only the service path,
     * not the full gateway path.
     */
    private static createServiceRequest(event: RequestEvent): ServiceRequestEvent {
        const requestedFullPath = event.url.pathname.split('/').filter(Boolean);

        // Derive base/catch positions from route id segments (keeps compatibility with your current approach)
        const routeId =
            event.route.id
                ?.split('/')
                .filter(Boolean)
                .filter((e) => !(e.startsWith('(') && e.endsWith(')'))) ?? [];

        const catchAllIndex = routeId.findIndex((segment) => segment.startsWith('[...'));
        if (catchAllIndex === -1) {
            throw new Error('Route must have a catch-all segment [...] at the end');
        }

        const basePathParts = requestedFullPath.slice(0, catchAllIndex);
        const basePath = '/' + (basePathParts.length > 0 ? basePathParts.join('/') : '');

        const servicePathParts = requestedFullPath.slice(catchAllIndex);
        const servicePath = servicePathParts.length > 0 ? '/' + servicePathParts.join('/') : '/';

        const serviceURL = new URL(event.url);
        serviceURL.pathname = servicePath;

        return {
            ...event,
            url: serviceURL,
            route: {
                ...event.route,
                service: servicePath,
                base: basePath,
                serviceURL,
                baseURL: new URL(basePath, event.url),
                originalURL: new URL(event.url)
            }
        } as ServiceRequestEvent;
    }

    /**
     * Call a service-local function (or retrieve a local value).
     *
     * This is an in-process call (no HTTP).
     */
    static Internal<T extends keyof App.Services>(
        name: T,
        ...args: ServiceLocalParameters<T>
    ): ServiceLocalReturn<T> {
        const service = ServiceManager.instance.services.get(name as string);
        if (!service) throw new ServiceError(404, `Service '${name}' not found`);

        if (!service.local) throw new ServiceError(503, `Service '${name}' has no local handler`);

        if (typeof service.local === 'function') {
            return service.local(...(args as any[]));
        }

        return service.local as ServiceLocalReturn<T>;
    }

    /**
     * Default HTTP entrypoint path used by clients.
     */
    static get EntryPoint() {
        return process.env['PUBLIC_SERVICE_ENTRYPOINT'] ?? '/api/v1/services';
    }
}

/**
 * Small JSON response helpers for service endpoints and actions.
 */
export const Action = {
    success: (code: number = 200, data?: Record<string, any>): Response =>
        new Response(
            JSON.stringify({
                data: data ? stringify(data) : undefined,
                type: 'success',
                status: code
            }),
            {
                status: code,
                headers: {'Content-Type': 'application/json'}
            }
        ),

    redirect: (code: number = 302, location: string): Response =>
        new Response(
            JSON.stringify({
                location,
                type: 'redirect',
                status: code
            }),
            {
                status: code,
                headers: {'Content-Type': 'application/json'}
            }
        ),

    error: (code: number = 500, err: App.Error): Response =>
        new Response(
            JSON.stringify({
                data: stringify(err),
                type: 'error',
                status: code
            }),
            {
                status: code,
                headers: {'Content-Type': 'application/json'}
            }
        ),

    fail: (code: number = 400, data: Record<string, any>): Response =>
        new Response(
            JSON.stringify({
                data: stringify(data),
                type: 'failure',
                status: code
            }),
            {
                status: code,
                headers: {'Content-Type': 'application/json'}
            }
        )
} as const;

/** Export Router factory. */
export const Router = ServiceRouter.New;
/** Export Service local caller. */
export const Service = ServiceManager.Internal;
/** Export default service entrypoint. */
export const EntryPoint = ServiceManager.EntryPoint;
/** Export WebHTTPServer helper. */
export const Server = WebHTTPServer;
/** Export WebProxyServer helper. */
export const Proxy = WebProxyServer;
/** Export middleware helper. */
export const middleware = mWare;

export {fail, error, json, text, file, isHttpErrorLike, isRedirectLike} from './helpers/index.js';
export type * from './helpers/index.js';

export type Server = InstanceType<typeof Server>;
