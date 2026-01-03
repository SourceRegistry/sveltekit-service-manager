import {
    error,
    type Action as SVAction,
    type RequestEvent,
    type RequestHandler,
    isHttpError,
    isRedirect
} from '@sveltejs/kit';

import {stringify} from 'devalue';
import {WebHTTPServer} from "$lib/server/helpers/WebHTTPServer.js";
import {WebProxyServer} from "$lib/server/helpers/WebProxyServer.js";

import {middleware as mWare} from "$lib/server/helpers/middleware.js";

type MaybePromise<T> = T | Promise<T>;

// Core type definitions
export type RequestMethods = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD' | 'PATCH' | 'OPTIONS';

/**
 * Strict param extractor
 * - [param] => string
 * - [...param] => string[]
 * - [[param]] => treated as string (optional syntax but required)
 */
export type ExtractPathParams<T extends string> =
    T extends `/${infer Segment}/${infer Rest}`
        ? MergeParams<ExtractSegmentParam<Segment>, ExtractPathParams<`/${Rest}`>>
        : T extends `/${infer Segment}`
            ? ExtractSegmentParam<Segment>
            : {};

export type ExtractSegmentParam<S extends string> =
    S extends `[...${infer Param}]` ? { [K in Param]: string } :
        S extends `[[${infer Param}]]` ? { [K in Param]: string } : // treat optional as required
            S extends `[${infer Param}]` ? { [K in Param]: string } :
                {};

export type MergeParams<A, B> = A & B;


export type RouteHandler<Path extends string> = (
    event: ServiceRequestEvent<RequestEvent['params'] & ExtractPathParams<Path>, Path>
) => MaybePromise<Response>;

// @ts-ignore
export type ActionHandler<Path extends string, OutputData extends Record<string, any> = Record<string, any>> = SVAction<ExtractPathParams<Path>, OutputData, Path>;

// Enhanced route definition
export interface Route<Path extends string> {
    readonly path: Path;
    readonly isAction: boolean;
    readonly regex: RegExp;
    readonly paramNames: ReadonlyArray<string>;
    readonly handler: RouteHandler<Path>;
    readonly method: RequestMethods;
    readonly isCatchAll: boolean;
    readonly isOptional: boolean;
    readonly priority: number; // For route matching order
}

interface NestedRouter {
    readonly prefix: string;
    readonly router: ServiceRouter;
    readonly regex: RegExp;
    readonly paramNames: ReadonlyArray<string>;
    readonly isCatchAll: boolean;
    readonly isOptional: boolean;
    readonly priority: number;
}

export type ServiceHandler<
    Params extends Record<string, string> = Record<string, string>,
    RouteId extends string | null = string | null
> = (event: ServiceRequestEvent<Params, RouteId>) => MaybePromise<Response>;

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

export interface ServiceEndpoint {
    access(...keys: (keyof App.Services)[]): void;

    readonly endpoint: Record<RequestMethods, RequestHandler>;
}

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

// Enhanced error handling
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

// Helper type for better error messages
type ErrorMessage<T extends string> = {
    readonly error: T;
    readonly __brand: never;
};

export type ServiceLocalParameters<T extends keyof App.Services> =
    App.Services[T] extends { local: (...args: infer Args) => any }
        ? Args
        : readonly [];

export type ServiceLocalReturn<T extends keyof App.Services> =
    App.Services[T] extends { local: (...args: any[]) => infer R }
        ? R
        : App.Services[T] extends { local: infer L }
            ? L
            : ErrorMessage<`Service '${T}' does not have a local function defined`>;

// Updated path regex creation with clean param names and correct catch-all behavior
const pathRegexCache = new Map<string, {
    regex: RegExp;
    paramNames: string[];
    isCatchAll: boolean;
    isOptional: boolean;
    priority: number;
}>();

const createPathRegex = <Path extends string>(path: Path) => {
    const cached = pathRegexCache.get(path);
    if (cached) return cached;

    const paramNames: string[] = [];
    let isCatchAll = false;
    let isOptional = false;
    let priority: number;

    const segments = path.split('/').filter(Boolean);
    priority = segments.reduce((acc, segment) => {
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

// Enhanced ServiceRouter with better performance and type safety
// Enhanced nested router interface with path parameter support
interface NestedRouter {
    readonly prefix: string;
    readonly router: ServiceRouter;
    readonly regex: RegExp;
    readonly paramNames: ReadonlyArray<string>;
    readonly isCatchAll: boolean;
    readonly isOptional: boolean;
    readonly priority: number;
}

// Enhanced ServiceRouter with better performance and type safety
export class ServiceRouter {
    private _routes: Route<any>[] = [];
    private _nestedRouters: NestedRouter[] = [];
    private routesSorted = false;

    /**
     * @warning this is a dangerous method only use this to read existing registered routes.
     * The router relies on this array to search for the corresponding route for your requests.
     */
    get routes(): readonly Route<any>[] {
        return this._routes;
    }

    /**
     * @warning this is a dangerous method only use this to read existing registered routers.
     * The router relies on this array to search for the corresponding routes for your requests.
     */
    get nestedRouters(): readonly NestedRouter[] {
        return this._nestedRouters;
    }

    // HTTP method handlers with improved type safety
    GET<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('GET', path, handler);
    }

    PUT<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('PUT', path, handler);
    }

    POST<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('POST', path, handler);
    }

    PATCH<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('PATCH', path, handler);
    }

    DELETE<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('DELETE', path, handler);
    }

    HEAD<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('HEAD', path, handler);
    }

    OPTIONS<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        return this.addHandler('OPTIONS', path, handler);
    }

    discard(path_or_prefix: string, method?: string): this {
        if (!method) this._nestedRouters = this._nestedRouters.filter(({prefix}) => path_or_prefix !== prefix);
        this._routes = this._routes.filter(({
                                                path,
                                                method: routeMethod
                                            }) => path !== path_or_prefix && method !== routeMethod);
        return this;
    }

    // Enhanced nested router support with path parameters
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

        return this;
    }

    // Enhanced action handler with better error handling
    action<Path extends string, OutputData extends Record<string, any> = Record<string, any>>(
        path: Path,
        handler: ActionHandler<Path, OutputData>
    ): this {
        return this.addHandler(
            'POST',
            path,
            async (event) => {
                try {
                    const params = this.extractPathParams(path, event.url.pathname);
                    const enhancedEvent = {
                        ...event,
                        params: {...event.params, ...params},
                        route: {...event.route, id: path}
                    } as ServiceRequestEvent<any, Path>;

                    const result = await handler(enhancedEvent as any);
                    return this.formatActionResult(result);
                } catch (error) {
                    return this.handleActionError(error);
                }
            },
            true
        );
    }

    // Universal handler for all HTTP methods
    USE<Path extends string>(path: Path, handler: RouteHandler<Path>): this {
        const methods: RequestMethods[] = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
        methods.forEach(method => this.addHandler(method, path, handler));
        return this;
    }

    public handle(event: ServiceRequestEvent): MaybePromise<Response> {
        const {url, request} = event;
        const method = request.method as RequestMethods;

        // Use the already processed service path from createServiceRequest
        const path = this.normalizePath(event.route.service || url.pathname);

        // Check nested routers first
        const nestedResponse = this.handleNestedRouters(event, path);
        if (nestedResponse) return nestedResponse;

        // Sort routes by priority if needed
        if (!this.routesSorted) {
            this.sortRoutes();
        }

        // Handle local routes with optimized matching
        return this.handleLocalRoutes(event, method, path);
    }

    // Private helper methods
    private addHandler<Path extends string>(
        method: RequestMethods,
        path: Path,
        handler: RouteHandler<Path>,
        isAction: boolean = false
    ): this {
        const {regex, paramNames, isCatchAll, isOptional, priority} = createPathRegex(path);

        this._routes.push({
            method,
            path,
            regex,
            paramNames,
            handler,
            isAction,
            isCatchAll,
            isOptional,
            priority
        });

        this.routesSorted = false; // Mark for re-sorting
        return this;
    }

    private sortRoutes(): void {
        this._routes.sort((a, b) => b.priority - a.priority);
        this.routesSorted = true;
    }

    private createPrefixRegex(prefix: string) {
        const paramNames: string[] = [];
        let isCatchAll = false;
        let isOptional = false;
        let priority: number;

        const segments = prefix.split('/').filter(Boolean);
        priority = segments.reduce((acc, segment) => {
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
                regexString += '/([^/]+)'; // Match at least one segment for catch-all in prefix
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

        // Key difference: Don't anchor the end, allow matching paths that START with this prefix
        return {
            regex: new RegExp(`^${regexString}(?=/|$)`),
            paramNames,
            isCatchAll,
            isOptional,
            priority
        };
    }

    private normalizePrefix(prefix: string): string {
        const normalized = prefix.startsWith('/') ? prefix : `/${prefix}`;
        return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
    }

    private normalizePath(path: string): string {
        return path.replace(/\/$/, '') || '/';
    }

    private extractPathParams<Path extends string>(
        routePath: Path,
        requestPath: string
    ): Record<string, string> {
        const {regex, paramNames, isCatchAll} = createPathRegex(routePath);
        const match = requestPath.match(regex);

        if (!match) return {};

        const params: Record<string, string> = {};

        if (isCatchAll && paramNames.length === 1) {
            const paramName = paramNames[0];
            // Return the full catch-all string, user handles splitting
            params[paramName] = match[1] || '';
        } else {
            paramNames.forEach((name, index) => {
                const value = match[index + 1];
                params[name] = value || '';
            });
        }

        return params;
    }

    private handleNestedRouters(event: ServiceRequestEvent, path: string): MaybePromise<Response> | null {
        // Sort nested routers by priority (more specific routes first)
        const sortedNestedRouters = [...this._nestedRouters].sort((a, b) => b.priority - a.priority);

        for (const nestedRouter of sortedNestedRouters) {
            // Check if path starts with this prefix pattern
            const prefixMatch = this.matchesPrefix(path, nestedRouter);
            if (!prefixMatch) continue;

            // Extract parameters from the prefix
            const prefixParams = this.extractPrefixParams(nestedRouter, prefixMatch.matchedPath);

            // Calculate the remaining path after stripping the matched prefix
            const remainingPath = prefixMatch.remainingPath;

            // Create new URL with the remaining path
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

    private matchesPrefix(
        path: string,
        nestedRouter: NestedRouter
    ): { matchedPath: string; remainingPath: string } | null {
        const match = path.match(nestedRouter.regex);
        if (!match || match.index !== 0) return null;

        const matchedPath = match[0];
        const remainingPath = path.slice(matchedPath.length);

        // Ensure remaining path starts with / or is empty
        const normalizedRemainingPath = remainingPath.startsWith('/') ? remainingPath : `/${remainingPath}`;

        return {
            matchedPath,
            remainingPath: normalizedRemainingPath || '/'
        };
    }

    private extractPrefixParams(
        nestedRouter: NestedRouter,
        matchedPath: string
    ): Record<string, string> {
        const match = matchedPath.match(nestedRouter.regex);
        if (!match) return {};

        const params: Record<string, string> = {};

        if (nestedRouter.isCatchAll && nestedRouter.paramNames.length === 1) {
            const paramName = nestedRouter.paramNames[0];
            params[paramName] = match[1] || '';
        } else {
            nestedRouter.paramNames.forEach((name, index) => {
                const value = match[index + 1];
                params[name] = value || '';
            });
        }

        return params;
    }

    private handleLocalRoutes(
        event: ServiceRequestEvent,
        method: RequestMethods,
        path: string
    ): MaybePromise<Response> {
        // Try exact matches and parameterized routes first
        for (const route of this._routes) {
            if (route.method !== method) continue;

            const match = path.match(route.regex);
            if (!match) continue;

            const params = this.extractPathParams(route.path, path);
            const enhancedEvent = {
                ...event,
                params: {...event.params, ...params},
                route: {...event.route, id: route.path}
            } as ServiceRequestEvent;

            return route.handler(enhancedEvent as any);
        }

        throw error(404, {message: `Route not found: ${method} ${path}`});
    }

    private formatActionResult(result: any): Response {
        if (result?.type === 'failure' && 'status' in result && result.status) {
            return Action.fail(result.status, result.data);
        }
        return Action.success(200, result ?? undefined);
    }

    private handleActionError(err: unknown): Response {
        if (isHttpError(err)) {
            return Action.error(err.status, err.body);
        }
        if (isRedirect(err)) {
            return Action.redirect(err.status, err.location);
        }
        throw err;
    }

    static New(): ServiceRouter {
        return new ServiceRouter();
    }
}

// Enhanced ServiceManager with better performance and type safety
export class ServiceManager {
    private static readonly instance = new ServiceManager();
    private readonly services = new Map<string, Service>();
    private readonly loadingPromises = new Map<string, Promise<void>>();

    private constructor() {}

    /**
     * Load a service with optional HMR support.
     * @param service The service definition
     * @param module Pass `import.meta` from the service file for HMR (dev only)
     */
    static async Load(
        service: MaybePromise<Service | {default: Service}>,
        module?: { hot?: { accept: (clb: () => void) => void } }
    ): Promise<Service> {
        const instance = ServiceManager.instance;
        const _service = await (async () => {
            let svc = await service;
            if ('default' in svc) svc = svc.default;
            return svc;
        })()


        if (instance.services.has(_service.name)) {
            return _service;
        }

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
                        const depNameStr = depName as string;
                        const dep = instance.services.get(depNameStr);
                        if (!dep) {
                            throw new ServiceError(500, `Dependency '${depNameStr}' of service '${svc.name}' not found`);
                        }
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

        if (import.meta.hot && module?.hot) {
            module.hot.accept(() => {
                ServiceManager.Reload(_service.name);
            });
        }

        return _service;
    }

    /**
     * Reload a service during HMR.
     * Calls `cleanup()` if defined, then removes from registry.
     */
    static async Reload(name: string): Promise<void> {
        const instance = ServiceManager.instance;
        const service = instance.services.get(name);
        if (!service) return;

        // Run cleanup if provided
        if (service.cleanup) {
            try {
                await service.cleanup();
            } catch (err) {
                console.warn(`Cleanup for service '${name}' failed:`, err);
            }
        }

        // Remove from registry
        instance.services.delete(name);
        instance.loadingPromises.delete(name);
        console.debug(`[ServiceManager] Hot-reloaded service: ${name}`);
    }

    // --- Rest of ServiceManager (unchanged except minor tweaks for clarity) ---

    static readonly ServiceSelector = {
        params: (name: string = 'service_name') => (event: RequestEvent): Service => {
            // @ts-ignore
            const serviceName = event.params[name];
            if (!serviceName) throw error(400, { message: `Service parameter '${name}' is required` });
            const service = ServiceManager.instance.services.get(serviceName);
            if (!service) throw error(404, { message: `Service '${serviceName}' not found` });
            return service;
        },
        query: (name: string = 'service_name') => (event: RequestEvent): Service => {
            const serviceName = event.url.searchParams.get(name);
            if (!serviceName) throw error(400, { message: `Service query parameter '${name}' is required` });
            const service = ServiceManager.instance.services.get(serviceName);
            if (!service) throw error(404, { message: `Service '${serviceName}' not found` });
            return service;
        }
    };

    static Base(
        serviceSelector: (event: RequestEvent) => MaybePromise<Service> =
        ServiceManager.ServiceSelector.params('service_name')
    ): ServiceEndpoint {
        const allowedServices = new Set<string>();
        const handle = async (event: RequestEvent): Promise<Response> => {
            try {
                const service = await serviceSelector(event);
                if (!allowedServices.has(service.name)) throw error(403, { message: `Service '${service.name}' is not accessible` });
                if (!service.route) throw error(503, { message: `Service '${service.name}' has no route handler` });
                const serviceRequest = ServiceManager.createServiceRequest(event);
                if (service.route instanceof ServiceRouter) {
                    return await service.route.handle(serviceRequest);
                } else if (typeof service.route === 'function') {
                    return await service.route(serviceRequest);
                } else {
                    const handler = service.route[event.request.method as RequestMethods];
                    if (!handler) throw error(405, { message: `Method ${event.request.method} not allowed` });
                    return await handler(serviceRequest);
                }
            } catch (err) {
                if (err instanceof ServiceError) throw error(err.status, { message: err.message });
                throw err;
            }
        };
        return {
            access: (...keys: (keyof App.Services)[]): void => {
                allowedServices.clear();
                keys.forEach(key => allowedServices.add(key as string));
            },
            endpoint: new globalThis.Proxy({} as Record<RequestMethods, RequestHandler>, { get: () => handle })
        };
    }

    private static createServiceRequest(event: RequestEvent): ServiceRequestEvent {
        const requestedFullPath = event.url.pathname.split('/').filter(Boolean);
        const routeId = event.route.id?.split('/')
            .filter(Boolean)
            .filter(e => !(e.startsWith('(') && e.endsWith(')'))) ?? [];

        const catchAllIndex = routeId.findIndex(segment => segment.startsWith('[...'));
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

    static Internal<T extends keyof App.Services>(
        name: T,
        ...args: ServiceLocalParameters<T>
    ): ServiceLocalReturn<T> {
        const service = ServiceManager.instance.services.get(name as string);
        if (!service) {
            throw new ServiceError(404, `Service '${name}' not found`);
        }
        if (!service.local) {
            throw new ServiceError(503, `Service '${name}' has no local handler`);
        }
        if (typeof service.local === 'function') {
            return service.local(...(args as any[]));
        }
        return service.local as ServiceLocalReturn<T>;
    }

    static get EntryPoint() {
        return process.env['PUBLIC_SERVICE_ENTRYPOINT'] ?? '/api/v1/services';
    }
}

// Enhanced Action utilities
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

    error: (code: number = 500, error: App.Error): Response =>
        new Response(
            JSON.stringify({
                data: stringify(error),
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

// Public exports
export const Router = ServiceRouter.New;
export const Service = ServiceManager.Internal;
export const EntryPoint = ServiceManager.EntryPoint
export const Server = WebHTTPServer
export const Proxy = WebProxyServer
export const middleware = mWare;
export {fail, error, json, text, file, isHttpErrorLike, isRedirectLike} from "./helpers/index.js"

export type Server = InstanceType<typeof Server>;

export type * from "./helpers/index.js"
