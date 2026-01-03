import {
    createServer as createHttpServer,
    type Server as HttpServer,
    IncomingMessage,
    type ServerOptions,
    ServerResponse
} from 'http';
import {
    createServer as createHttpsServer,
    type Server as HttpsServer,
    type ServerOptions as HttpsServerOptions
} from 'https';
import {TLSSocket} from 'tls';
import {Readable} from 'stream';
import {Writable} from 'stream';
import * as cookie from 'cookie';
import {isHttpError, isRedirect, type RequestEvent} from '@sveltejs/kit';
import type {Cookies as SVCookie} from '@sveltejs/kit';
import {ServiceRouter} from "../index.js";

export class Cookies implements SVCookie {
    private readonly requestCookies: Record<string, string>;
    private newCookies: string[] = [];
    private readonly setCookieHeader: (name: string, value: string, opts: cookie.CookieSerializeOptions) => void;

    constructor(request: Request, setCookieHeader: (name: string, value: string, opts: cookie.CookieSerializeOptions) => void, options?: cookie.CookieParseOptions) {
        const cookieHeader = request.headers.get('cookie') ?? '';
        this.requestCookies = cookie.parse(cookieHeader, options);
        this.setCookieHeader = setCookieHeader;
    }

    get(name: string): string | undefined {
        return this.requestCookies[name];
    }

    getAll(): { name: string; value: string }[] {
        return Object.entries(this.requestCookies).map(([name, value]) => ({name, value}));
    }

    set(name: string, value: string, opts: cookie.CookieSerializeOptions & { path: string }): void {
        const serialized = cookie.serialize(name, value, opts);
        this.newCookies.push(serialized);
        this.setCookieHeader(name, value, opts);
    }

    delete(name: string, opts: cookie.CookieSerializeOptions & { path: string }): void {
        this.set(name, '', {...opts, maxAge: 0});
    }

    serialize(name: string, value: string, opts: cookie.CookieSerializeOptions & { path: string }): string {
        return cookie.serialize(name, value, opts);
    }
}

// Type definitions for server configuration
export type HttpServerConfig = {
    type: 'http';
    options?: ServerOptions;
};

export type HttpsServerConfig = {
    type: 'https';
    options: HttpsServerOptions; // Required for HTTPS
};

export type ServerConfig = HttpServerConfig | HttpsServerConfig;

// Handler configuration types
export type HandlerConfig = {
    locals?: (event: RequestEvent) => App.Locals | Record<string, any>;
    platform?: (event: RequestEvent) => App.Platform | Record<string, any>;
} & ({
    request: (event: RequestEvent) => Promise<Response> | Response;
    router?: never;
} | {
    router: ServiceRouter;
    request?: never;
});

export class WebHTTPServer<TServerConfig extends ServerConfig = HttpServerConfig> {
    private _server!: TServerConfig['type'] extends 'https' ? HttpsServer : HttpServer;
    private readonly config: TServerConfig;

    private get server(): TServerConfig['type'] extends 'https' ? HttpsServer : HttpServer {
        if (!this._server) {
            if (this.config.type === 'https') {
                this._server = createHttpsServer(
                    this.config.options as HttpsServerOptions,
                    this.handleRequest.bind(this)
                ) as TServerConfig['type'] extends 'https' ? HttpsServer : HttpServer;
            } else {
                this._server = createHttpServer(
                    this.config.options as ServerOptions,
                    this.handleRequest.bind(this)
                ) as TServerConfig['type'] extends 'https' ? HttpsServer : HttpServer;
            }
        }
        return this._server;
    }

    constructor(
        private handlers: HandlerConfig,
        config?: TServerConfig
    ) {
        // Default to HTTP if no config provided
        this.config = config ?? ({type: 'http', options: {}} as TServerConfig);
    }

    listen(...args: Parameters<HttpServer['listen']>): this {
        this.server.listen(...args);
        return this;
    }

    close(callback?: (err?: Error) => void): void {
        this.server.close(callback);
    }

    address(): string | import('net').AddressInfo | null {
        return this.server.address();
    }

    get listening(): boolean {
        return this.server.listening;
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const request = this.toWebRequest(req);
            const setHeaders: Record<string, string> = {};
            const setCookies: string[] = [];

            const event = this.toRequestEvent(request, {
                getClientAddress: () => req.socket.remoteAddress ?? '',
                setHeader: (name: string, value: string) => {
                    setHeaders[name] = value;
                },
                pushSetCookie: (value: string) => {
                    setCookies.push(value);
                },
                handlers: this.handlers
            });

            let response: Response;
            try {
                if (this.handlers.router) {
                    response = await this.handlers.router.handle({
                        ...event,
                        params: {},
                        route: {
                            ...event.route,
                            service: event.url.pathname,
                            base: "",
                            serviceURL: event.url,
                            baseURL: new URL("/", event.url),
                            originalURL: new URL(event.url)
                        }
                    });
                } else if (this.handlers.request) {
                    response = await this.handlers.request(event);
                } else {
                    throw new Error("No request handler provided");
                }

                // Apply collected headers
                for (const [name, value] of Object.entries(setHeaders)) {
                    res.setHeader(name, value);
                }

                // Append Set-Cookie headers
                if (setCookies.length > 0) {
                    res.setHeader('Set-Cookie', setCookies);
                }
            } catch (err) {
                if (isHttpError(err)) {
                    response = new Response(JSON.stringify(err), {
                        status: err.status,
                        headers: {'Content-Type': 'application/json'}
                    });
                } else if (isRedirect(err)) {
                    response = new Response(null, {
                        status: err.status,
                        headers: {'Location': err.location}
                    });
                } else {
                    // Throw error if not svelte kit error
                    throw err;
                }
            }

            await this.sendWebResponse(res, response);
        } catch (err) {
            console.error('Request error:', err);
            res.statusCode = 500;
            res.end('Internal Server Error');
        }
    }

    private toWebRequest(req: IncomingMessage): Request {
        const {method = 'GET', headers, url} = req;
        const protocol = req.socket instanceof TLSSocket ? 'https' : 'http';
        const fullUrl = `${protocol}://${headers.host}${url}`;
        let body: BodyInit | null = null;

        if (method !== 'GET' && method !== 'HEAD') {
            body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        }

        return new Request(fullUrl, {
            method,
            headers: new Headers(Object.entries(headers) as [string, string][]),
            body,
            // @ts-expect-error - duplex is required for requests with body
            duplex: 'half' as any
        });
    }

    private async sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));

        if (!response.body) {
            res.end();
            return;
        }

        const reader = response.body.getReader();
        const writer = Writable.toWeb(res).getWriter();

        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                await writer.write(value);
            }
        } finally {
            await writer.close();
        }
    }

    public toRequestEvent(
        request: Request,
        utils: {
            getClientAddress: () => string;
            setHeader: (name: string, value: string) => void;
            pushSetCookie: (value: string) => void;
            handlers?: {
                locals?: (event: RequestEvent) => App.Locals;
                platform?: (event: RequestEvent) => App.Platform;
            };
        }
    ): RequestEvent<{}, null> {
        const cookieSetter = (name: string, value: string, opts: cookie.CookieSerializeOptions) => {
            const serialized = cookie.serialize(name, value, opts);
            utils.pushSetCookie(serialized);
        };

        const cookies = new Cookies(request, cookieSetter);

        return {
            isRemoteRequest: false,
            tracing: {current: undefined, enabled: false, root: undefined},
            cookies,
            request,
            url: new URL(request.url),
            fetch: globalThis.fetch,
            getClientAddress: utils.getClientAddress,
            get locals() {
                return utils.handlers?.locals ? utils.handlers?.locals?.(this) : {} as App.Locals;
            },
            params: {},
            get platform() {
                return utils.handlers?.platform ? utils.handlers?.platform?.(this) : {name: "WebHTTPServer"} as App.Platform;
            },
            route: {id: null},
            isDataRequest: false,
            isSubRequest: false,
            setHeaders: (headers: Record<string, string>) => {
                for (const [name, value] of Object.entries(headers)) {
                    utils.setHeader(name, value);
                }
            }
        };
    }
}
