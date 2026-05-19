import {env} from "$env/dynamic/public";

export type PublicServices = {
    [K in keyof App.Services]: 'route' extends keyof App.Services[K] ? K : never;
}[keyof App.Services];

export type ServiceRouteOptions = Partial<{
    includeSearchParams: boolean,
    fullUrl: boolean
}>;

export class ServiceError extends Error {

    get name() {
        return this.res.statusText
    }

    get code() {
        return this.res.status
    }

    get response() {
        return this.res
    }

    private _data: string | object | undefined
    get data() {
        return this._data;
    }

    static async Create(res: Response) {
        let details: string | object | undefined = undefined;
        if (res.headers.has('content-type')) {
            if (res.headers.get('content-type') === 'application/json') {
                details = await res.json()
            } else {
                details = await res.text()
            }
        }
        const error = new ServiceError(res);
        error._data = details;
        return error;
    }

    static Check(res: Response) {
        if (res.ok) return res;
        else throw ServiceError.Create(res);
    }

    constructor(private readonly res: Response) {
        super();
    }
}

export const publicBaseEntryPoint = env.PUBLIC_SERVICE_ENTRYPOINT ?? '/api/v1/services'

/**
 * This method is used to call the services that expose routes to the client
 * @param service name of the service
 * @param config
 * @constructor
 */
export const Service = (service: PublicServices, config: Partial<{
    entryPoint: string,
    url: URL
    executor: typeof fetch,
    params: import("@sveltejs/kit").Page['params']
}> = {}) => {
    let {entryPoint = publicBaseEntryPoint, executor = fetch} = config;
    if (entryPoint.includes("[")) {
        if (!config.params) throw `Client service call requires params to resolve '${entryPoint}'.`
        Object.entries(config.params).forEach(([key, value]) =>
            entryPoint = entryPoint.replaceAll(`[${key}]`, value).replaceAll(`[...${key}]`, value)
        )
    }
    if (entryPoint.includes("[")) throw `Client service call requires params to resolve '${entryPoint}'.`

    const _entryPoint = `${entryPoint}/${service}`

    const _route = (path: `/${string}`, options: ServiceRouteOptions = {}) => {
        const route = `${_entryPoint}${path}`;
        let resolvedRoute = route;

        if (options.includeSearchParams && config.url) {
            const hashIndex = route.indexOf("#");
            const baseRoute = hashIndex === -1 ? route : route.slice(0, hashIndex);
            const hash = hashIndex === -1 ? "" : route.slice(hashIndex);

            const queryIndex = baseRoute.indexOf("?");
            const pathname = queryIndex === -1 ? baseRoute : baseRoute.slice(0, queryIndex);
            const search = new URLSearchParams(queryIndex === -1 ? "" : baseRoute.slice(queryIndex + 1));

            config.url.searchParams.forEach((value, key) => {
                search.append(key, value);
            });

            const query = search.toString();
            resolvedRoute = `${pathname}${query ? `?${query}` : ""}${hash}`;
        }

        if (!options.fullUrl) return resolvedRoute;
        if (!config.url) throw "config.url must be a valid URL."
        return new URL(resolvedRoute, config.url.origin).href;
    }

    return ({
        get entryPoint() {
            return _entryPoint;
        },
        route(path: `/${string}`, options: ServiceRouteOptions = {}) {
            return _route(path,options);
        },
        url(path: `/${string}`, options: Omit<ServiceRouteOptions, 'fullUrl'> = {}): URL {
            if (!config.url) throw "config.url must be a valid URL."
            return new URL(_route(path, {...options, fullUrl: false}), config.url.origin);
        },
        raw(route: string, requestInit?: Omit<RequestInit, 'body'> & { body?: object | RequestInit['body'] }) {
            if (requestInit && requestInit.body) {
                if (!requestInit.method) requestInit.method = 'POST'
                if (requestInit && typeof requestInit.body === 'object') {
                    requestInit.body = JSON.stringify(requestInit.body);
                    if (!requestInit.headers) requestInit.headers = {};
                    (requestInit.headers as Record<string, string>)['content-type'] = 'application/json';
                }
            }
            return executor(`${this.entryPoint}${route}`, requestInit as RequestInit)
        },
        async call<R = any>(route: `/${string}`, data?: object | RequestInit['body'], requestInit?: Omit<RequestInit, 'body'>): Promise<R> {
            const res = await this.raw(route, {
                ...requestInit,
                body: data,
            });
            const res_1 = ServiceError.Check(res);
            return await res_1.json() as Promise<R>;
        }
    });
}
