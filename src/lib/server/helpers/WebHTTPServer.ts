import {
    createServer as createHttpServer,
    IncomingMessage,
    type Server as HttpServer,
    type ServerOptions,
    ServerResponse
} from 'http';
import {
    createServer as createHttpsServer,
    type Server as HttpsServer,
    type ServerOptions as HttpsServerOptions
} from 'https';
import {TLSSocket} from 'tls';
import {Readable, Writable} from 'stream';
import * as cookie from 'cookie';
import type {Cookies as SVCookie} from '@sveltejs/kit';
import {isHttpError, isRedirect, type RequestEvent} from '@sveltejs/kit';
import {ServiceRouter} from '../index.js';

/**
 * Minimal SvelteKit-compatible cookie implementation for non-SvelteKit servers.
 * Reads cookies from the incoming Request and collects Set-Cookie values for the outgoing response.
 */
export class Cookies implements SVCookie {
    private readonly requestCookies: Record<string, string>;
    private readonly setCookieHeader: (name: string, value: string, opts: cookie.CookieSerializeOptions) => void;

    constructor(
        request: Request,
        setCookieHeader: (name: string, value: string, opts: cookie.CookieSerializeOptions) => void,
        options?: cookie.CookieParseOptions
    ) {
        const cookieHeader = request.headers.get('cookie') ?? '';
        this.requestCookies = cookie.parse(cookieHeader, options);
        this.setCookieHeader = setCookieHeader;
    }

    get(name: string): string | undefined {
        return this.requestCookies[name];
    }

    getAll(): { name: string; value: string }[] {
        return Object.entries(this.requestCookies).map(([name, value]) => ({ name, value }));
    }

    set(name: string, value: string, opts: cookie.CookieSerializeOptions & { path: string }): void {
        this.setCookieHeader(name, value, opts);
    }

    delete(name: string, opts: cookie.CookieSerializeOptions & { path: string }): void {
        this.set(name, '', { ...opts, maxAge: 0 });
    }

    serialize(name: string, value: string, opts: cookie.CookieSerializeOptions & { path: string }): string {
        return cookie.serialize(name, value, opts);
    }
}

/** Configuration for an HTTP server. */
export type HttpServerConfig = {
    type: 'http';
    options?: ServerOptions;
};

/** Configuration for an HTTPS server. (TLS options required) */
export type HttpsServerConfig = {
    type: 'https';
    options: HttpsServerOptions;
};

export type ServerConfig = HttpServerConfig | HttpsServerConfig;

/**
 * Handler configuration:
 * - Provide `router` to route requests with a ServiceRouter
 * - Or provide `request` to handle requests directly
 *
 * Optionally provide `locals` and `platform` factories to mimic SvelteKit event behavior.
 */
export type HandlerConfig = {
    locals?: (event: RequestEvent) => App.Locals | Record<string, any>;
    platform?: (event: RequestEvent) => App.Platform | Record<string, any>;
} & (
    | {
    request: (event: RequestEvent) => Promise<Response> | Response;
    router?: never;
}
    | {
    router: ServiceRouter;
    request?: never;
}
    );

/**
 * A minimal HTTP/HTTPS server that adapts Node's IncomingMessage/ServerResponse
 * to a Fetch API Request/Response and a SvelteKit-like RequestEvent.
 *
 * Key properties:
 * - Supports streaming request bodies (Readable.toWeb)
 * - Supports streaming response bodies (pipeTo with fallback)
 * - Collects set-cookie calls made via event.cookies
 * - Can dispatch via ServiceRouter or a custom request handler
 */
export class WebHTTPServer<TServerConfig extends ServerConfig = HttpServerConfig> {
    private _server!: TServerConfig['type'] extends 'https' ? HttpsServer : HttpServer;
    private readonly config: TServerConfig;

    private get server(): TServerConfig['type'] extends 'https' ? HttpsServer : HttpServer {
        if (!this._server) {
            if (this.config.type === 'https') {
                this._server = createHttpsServer(
                    this.config.options as HttpsServerOptions,
                    this.handleRequest.bind(this)
                ) as any;
            } else {
                this._server = createHttpServer(
                    this.config.options as ServerOptions,
                    this.handleRequest.bind(this)
                ) as any;
            }
        }
        return this._server;
    }

    constructor(private handlers: HandlerConfig, config?: TServerConfig) {
        // Default to HTTP if no config provided
        this.config = config ?? ({ type: 'http', options: {} } as TServerConfig);
    }

    /** Start listening. */
    listen(...args: Parameters<HttpServer['listen']>): this {
        this.server.listen(...args);
        return this;
    }

    /** Stop listening. */
    close(callback?: (err?: Error) => void): void {
        this.server.close(callback);
    }

    /** Return the bound address (if any). */
    address(): string | import('net').AddressInfo | null {
        return this.server.address();
    }

    /** Whether the server is currently listening. */
    get listening(): boolean {
        return this.server.listening;
    }

    /**
     * Main request handler.
     * Converts Node request to Fetch Request + SvelteKit-like RequestEvent, then resolves a Response and streams it.
     */
    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const request = this.toWebRequest(req);

            // Collect headers set via event.setHeaders() and cookies set via event.cookies
            const setHeaders = new Map<string, string>();
            const setCookies: string[] = [];

            const event = this.toRequestEvent(request, {
                getClientAddress: () => req.socket.remoteAddress ?? '',
                setHeader: (name: string, value: string) => {
                    setHeaders.set(name, value);
                },
                pushSetCookie: (value: string) => {
                    setCookies.push(value);
                },
                handlers: this.handlers
            });

            let response: Response;

            try {
                if (this.handlers.router) {
                    // WebHTTPServer exposes the router directly on full pathname
                    response = await this.handlers.router.handle({
                        ...event,
                        params: {},
                        route: {
                            ...event.route,
                            service: event.url.pathname,
                            base: '',
                            serviceURL: event.url,
                            baseURL: new URL('/', event.url),
                            originalURL: new URL(event.url)
                        }
                    });
                } else if (this.handlers.request) {
                    response = await this.handlers.request(event);
                } else {
                    throw new Error('No request handler provided');
                }
            } catch (err) {
                // Normalize SvelteKit error shapes into Responses
                if (isHttpError(err)) {
                    const body = (err.body ?? { message: 'HttpError' }) as any;
                    response = new Response(JSON.stringify(body), {
                        status: err.status,
                        headers: { 'Content-Type': 'application/json' }
                    });
                } else if (isRedirect(err)) {
                    response = new Response(null, {
                        status: err.status,
                        headers: { Location: err.location }
                    });
                } else {
                    throw err;
                }
            }

            // Apply collected headers (event.setHeaders)
            for (const [name, value] of setHeaders) {
                res.setHeader(name, value);
            }

            // Append Set-Cookie from event.cookies
            if (setCookies.length > 0) {
                // If something already set cookies, merge
                const existing = res.getHeader('Set-Cookie');
                if (typeof existing === 'string') {
                    res.setHeader('Set-Cookie', [existing, ...setCookies]);
                } else if (Array.isArray(existing)) {
                    res.setHeader('Set-Cookie', [...existing, ...setCookies]);
                } else {
                    res.setHeader('Set-Cookie', setCookies);
                }
            }

            await this.sendWebResponse(res, response);
        } catch (err) {
            console.error('Request error:', err);
            if (!res.headersSent) res.statusCode = 500;
            res.end('Internal Server Error');
        }
    }

    /**
     * Convert a Node IncomingMessage to a Fetch API Request.
     *
     * Notes:
     * - Preserves multi-value headers
     * - Streams body for non-GET/HEAD
     * - Adds duplex=half for Node fetch compatibility (when body is present)
     */
    private toWebRequest(req: IncomingMessage): Request {
        const method = req.method ?? 'GET';
        const protocol = req.socket instanceof TLSSocket ? 'https' : 'http';
        const host = req.headers.host ?? 'localhost';
        const url = req.url ?? '/';

        const fullUrl = `${protocol}://${host}${url}`;

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
                for (const v of value) headers.append(key, v);
            } else {
                headers.set(key, value);
            }
        }

        // Only stream body when a body is expected
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const body = hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null;

        return new Request(fullUrl, {
            method,
            headers,
            body,
            // @ts-expect-error Node Fetch requires duplex when streaming a request body
            duplex: hasBody ? ('half' as any) : undefined
        });
    }

    /**
     * Stream a Fetch Response into a Node ServerResponse.
     *
     * Uses `pipeTo` when available for better backpressure handling.
     * Falls back to manual reader loop.
     */
    private async sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
        // Status + headers
        res.statusCode = response.status;

        // Avoid overriding Set-Cookie already set at the Node layer; but normal headers are fine.
        response.headers.forEach((value, key) => {
            // Node expects `set-cookie` as array; if handler returned multiple cookies, Fetch folds them.
            // Prefer cookie collection via event.cookies. If you want to support handler-set cookies too,
            // you can special-case here.
            if (key.toLowerCase() === 'set-cookie') return;
            res.setHeader(key, value);
        });

        if (!response.body) {
            res.end();
            return;
        }

        const writable = Writable.toWeb(res);

        // If pipeTo exists, use it (handles backpressure correctly)
        // Node's WritableStream close will end the response.
        try {
            if ('pipeTo' in response.body) {
                await response.body.pipeTo(writable as any);
                return;
            }
        } catch (err) {
            // If client disconnects, Node can throw errors; treat as non-fatal.
            // You may want to inspect err codes here if desired.
        }

        // Fallback manual streaming
        const reader = response.body.getReader();
        const writer = (writable as any).getWriter();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writer.write(value);
            }
        } finally {
            try {
                await writer.close();
            } catch {
                // ignore close errors on disconnect
            }
        }
    }

    /**
     * Create a SvelteKit-like RequestEvent for handlers.
     *
     * This is intentionally minimal, but:
     * - supports cookies
     * - supports setHeaders
     * - supports locals/platform factories
     * - provides fetch, url, request, getClientAddress
     */
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

        // Memoize locals/platform to avoid repeated factory calls
        let _locals: any | undefined;
        let _platform: any | undefined;

        return {
            isRemoteRequest: false,
            tracing: {current: undefined, enabled: false, root: undefined},
            cookies,
            request,
            url: new URL(request.url),
            fetch: globalThis.fetch,
            getClientAddress: utils.getClientAddress,
            get locals() {
                if (_locals !== undefined) return _locals;
                _locals = utils.handlers?.locals ? utils.handlers.locals(this as any) : ({} as App.Locals);
                return _locals;
            },
            params: {},
            get platform() {
                if (_platform !== undefined) return _platform;
                _platform = utils.handlers?.platform
                    ? utils.handlers.platform(this as any)
                    : ({name: 'WebHTTPServer'} as any);
                return _platform;
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
