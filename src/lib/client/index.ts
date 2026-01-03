import {env} from "$env/dynamic/public";

export type PublicServices = {
    [K in keyof App.Services]: 'route' extends keyof App.Services[K] ? K : never;
}[keyof App.Services];

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
    return ({
        get entryPoint() {
            return `${entryPoint}/${service}`;
        },
        route(path: `/${string}`) {
            return `${this.entryPoint}${path}`
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
        call<R = any>(route: `/${string}`, data?: object | RequestInit['body'], requestInit?: Omit<RequestInit, 'body'>): Promise<R> {
            return this.raw(route, {
                ...requestInit,
                body: data,
            })
                .then(ServiceError.Check)
                .then((res) => res.json() as Promise<R>)
        }
    });
}
