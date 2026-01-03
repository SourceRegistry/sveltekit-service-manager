import { EventEmitter } from 'events';
import { Socket } from 'net';
import {
    IncomingMessage,
    ServerResponse,
    type OutgoingHttpHeaders,
    type OutgoingHttpHeader,
    type Server,
    type RequestListener,
    STATUS_CODES
} from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'node:stream';
import type { ServiceRequestEvent } from '../index.js';

/**
 * A small deferred promise helper that can be resolved/rejected externally.
 */
class Deferred<T = void> {
    public readonly promise: Promise<T>;
    public resolve!: (value: T | PromiseLike<T>) => void;
    public reject!: (reason?: any) => void;

    private _isResolved = false;
    private _isRejected = false;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = (value) => {
                if (!this._isResolved && !this._isRejected) {
                    this._isResolved = true;
                    resolve(value);
                }
            };
            this.reject = (reason) => {
                if (!this._isResolved && !this._isRejected) {
                    this._isRejected = true;
                    reject(reason);
                }
            };
        });
    }

    /** True if resolved. */
    get isResolved(): boolean {
        return this._isResolved;
    }

    /** True if rejected. */
    get isRejected(): boolean {
        return this._isRejected;
    }

    /** True if neither resolved nor rejected. */
    get isPending(): boolean {
        return !this._isResolved && !this._isRejected;
    }

    /** Convenience to resolve/reject from promise chains. */
    step<TResult2 = never>(): [
        onfulfilled?: ((value: T) => T | PromiseLike<T>) | undefined | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
    ] {
        return [
            (r) => {
                this.resolve(r);
                return r;
            },
            (reason) => {
                this.reject(reason);
                return reason;
            }
        ];
    }
}

/**
 * Minimal socket stub used to satisfy Node http classes without real network IO.
 *
 * Express and related middleware sometimes read:
 * - socket.remoteAddress / localAddress
 * - socket.encrypted (https)
 * - socket.destroyed
 */
class MockSocket extends EventEmitter {
    public readable = true;
    public writable = true;
    public destroyed = false;

    public remoteAddress: string = '127.0.0.1';
    public remotePort: number = 0;
    public localAddress: string = '127.0.0.1';
    public localPort: number = 0;

    // Some stacks check this to determine HTTPS.
    public encrypted: boolean = false;

    address() {
        return { port: 80, family: 'IPv4', address: '127.0.0.1' };
    }

    destroy(_err?: any) {
        this.destroyed = true;
        this.emit('close');
        return this;
    }

    end() {
        return this;
    }

    pause() {
        return this;
    }

    resume() {
        return this;
    }

    setTimeout() {
        return this;
    }

    write() {
        return true;
    }

    ref() {
        return this;
    }

    unref() {
        return this;
    }
}

const WEB_IMPL = Symbol('webImpl');

/**
 * Adapter: Fetch Request -> Node IncomingMessage (Readable)
 *
 * This exists to run Express-style middleware stacks against a Fetch Request.
 *
 * Backpressure:
 * - When `push()` returns false, we pause until Node calls `_read()` again.
 */
class WebProxyIncomingMessage extends IncomingMessage {
    [WEB_IMPL]: {
        body: ReadableStream<Uint8Array> | null;
        bodyReader: ReadableStreamDefaultReader<Uint8Array> | null;
        isReading: boolean;
        waitForRead: Deferred<void> | null;
    };

    constructor(request: Request) {
        // IncomingMessage wants a Socket-ish object; we provide a compatible stub.
        super(new MockSocket() as any);

        const url = new URL(request.url);
        this.url = url.pathname + url.search;
        this.method = request.method;

        // Headers (Node-style)
        this.headers = Object.create(null);
        (this as any).headersDistinct = Object.create(null);
        this.rawHeaders = [];

        request.headers.forEach((value, key) => {
            const lowerKey = key.toLowerCase();
            this.rawHeaders.push(key, value);

            const existing = this.headers[lowerKey];
            if (existing === undefined) this.headers[lowerKey] = value;
            else if (Array.isArray(existing)) existing.push(value);
            else this.headers[lowerKey] = [existing as string, value];

            const distinct = (this as any).headersDistinct[lowerKey] as string[] | undefined;
            if (!distinct) (this as any).headersDistinct[lowerKey] = [value];
            else distinct.push(value);
        });

        this.httpVersion = '1.1';
        this.httpVersionMajor = 1;
        this.httpVersionMinor = 1;

        this.complete = true;
        this.aborted = false;

        this.rawTrailers = [];
        this.trailers = Object.create(null);
        (this as any).trailersDistinct = Object.create(null);

        this[WEB_IMPL] = {
            body: request.body,
            bodyReader: null,
            isReading: false,
            waitForRead: null
        };

        if (request.body) void this._startBodyReading();
        else process.nextTick(() => this.push(null)); // end immediately
    }

    /**
     * Called by Node when the consumer wants more data.
     * We use this as the signal to resume pushing when backpressure previously paused us.
     */
    _read() {
        const impl = this[WEB_IMPL];
        if (impl.waitForRead?.isPending) impl.waitForRead.resolve();
    }

    private async _waitForReadDemand(): Promise<void> {
        const impl = this[WEB_IMPL];
        if (!impl.waitForRead || !impl.waitForRead.isPending) impl.waitForRead = new Deferred<void>();
        await impl.waitForRead.promise;
        impl.waitForRead = null;
    }

    private async _startBodyReading() {
        const impl = this[WEB_IMPL];
        if (!impl.body || impl.isReading) return;

        impl.isReading = true;

        try {
            impl.bodyReader = impl.body.getReader();

            while (true) {
                const { done, value } = await impl.bodyReader.read();
                if (done) {
                    this.push(null);
                    break;
                }

                const ok = this.push(Buffer.from(value));
                if (!ok) await this._waitForReadDemand();
            }
        } catch (error) {
            this.destroy(error as Error);
        } finally {
            impl.isReading = false;
        }
    }

    /**
     * Override setTimeout to keep chainable behavior expected by some middleware.
     */
    setTimeout(msecs: number, callback?: () => void): this {
        if (callback) setTimeout(callback, msecs);
        return this;
    }
}

/**
 * Adapter: Node ServerResponse -> Fetch Response
 *
 * Designed for Express compatibility:
 * - Supports setHeader/getHeader/removeHeader/writeHead/write/end/flushHeaders
 * - Streams response body through a TransformStream to a Fetch Response
 * - Resolves a Deferred<Response> exactly once, when headers are first sent
 */
class WebProxyServerResponse<Request extends IncomingMessage = IncomingMessage> extends ServerResponse<Request> {
    [WEB_IMPL]: {
        headers: OutgoingHttpHeaders;
        headersSent: boolean;
        finished: boolean;
        stream: {
            readable: ReadableStream<Uint8Array>;
            writer: WritableStreamDefaultWriter<Uint8Array>;
            closed: boolean;
        };
        responseDeferred: Deferred<Response>;
        originalMethods: {
            setHeader: (name: string, value: number | string | readonly string[]) => void;
            getHeader: (name: string) => number | string | string[] | undefined;
            removeHeader: (name: string) => void;
            writeHead: (
                statusCode: number,
                statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
                headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]
            ) => void;
            write: (
                chunk: any,
                encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
                callback?: (error: Error | null | undefined) => void
            ) => boolean;
            end: (
                chunk?: any,
                encoding?: BufferEncoding | (() => void),
                callback?: () => void
            ) => WebProxyServerResponse<Request>;
            _sendHeaders: () => void;
            flushHeaders: () => void;
        };
    };

    /** Express compatibility: `res.locals` */
    public locals: any;

    constructor(req: Request, responseDeferred: Deferred<Response>) {
        super(req);

        // Assign a mock socket to satisfy ServerResponse internals
        super.assignSocket(new MockSocket() as any);

        this.locals = Object.create(null);

        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();

        this[WEB_IMPL] = {
            headers: Object.create(null),
            headersSent: false,
            finished: false,
            stream: { readable, writer, closed: false },
            responseDeferred,
            originalMethods: {
                setHeader: this._webSetHeader.bind(this),
                getHeader: this._webGetHeader.bind(this),
                removeHeader: this._webRemoveHeader.bind(this),
                writeHead: this._webWriteHead.bind(this),
                write: this._webWrite.bind(this),
                end: this._webEnd.bind(this),
                _sendHeaders: this._webSendHeaders.bind(this),
                flushHeaders: this._webFlushHeaders.bind(this)
            }
        };

        this._setupWebApiIntegration();
    }

    /**
     * Lock down methods that Express/middleware frequently override via prototypes.
     * We expose stable behavior backed by our Web Response implementation.
     */
    private _setupWebApiIntegration() {
        const impl = this[WEB_IMPL];

        const lock = (name: string, value: any) => {
            Object.defineProperty(this, name, {
                value,
                writable: false,
                enumerable: false,
                configurable: false
            });
        };

        lock('setHeader', impl.originalMethods.setHeader);
        lock('getHeader', impl.originalMethods.getHeader);
        lock('removeHeader', impl.originalMethods.removeHeader);
        lock('writeHead', impl.originalMethods.writeHead);
        lock('write', impl.originalMethods.write);
        lock('end', impl.originalMethods.end);
        lock('_sendHeaders', impl.originalMethods._sendHeaders);
        lock('flushHeaders', impl.originalMethods.flushHeaders);

        Object.defineProperty(this, 'headersSent', {
            get: () => impl.headersSent,
            enumerable: true,
            configurable: false
        });

        Object.defineProperty(this, 'finished', {
            get: () => impl.finished,
            enumerable: true,
            configurable: false
        });
    }

    private _webSetHeader(name: string, value: number | string | readonly string[]) {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) throw new Error('Cannot set headers after they are sent');

        impl.headers[name.toLowerCase()] = value as any;
        return super.setHeader(name, value as any);
    }

    private _webGetHeader(name: string) {
        return this[WEB_IMPL].headers[name.toLowerCase()] as any;
    }

    private _webRemoveHeader(name: string) {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) throw new Error('Cannot remove headers after they are sent');

        delete impl.headers[name.toLowerCase()];
        super.removeHeader(name);
    }

    private _webWriteHead(
        statusCode: number,
        statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
        headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]
    ) {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) throw new Error('Cannot set headers after they are sent');

        this.statusCode = statusCode;

        if (typeof statusMessageOrHeaders === 'string') {
            this.statusMessage = statusMessageOrHeaders;
            if (headers) this._setHeadersFromParam(headers);
        } else if (statusMessageOrHeaders) {
            this._setHeadersFromParam(statusMessageOrHeaders);
        }

        impl.originalMethods._sendHeaders();
        return this;
    }

    private _webWrite(
        chunk: any,
        encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
        callback?: (error: Error | null | undefined) => void
    ): boolean {
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }

        const impl = this[WEB_IMPL];
        if (impl.finished) {
            callback?.(new Error('Cannot write after end'));
            return false;
        }

        if (!impl.headersSent) impl.originalMethods._sendHeaders();

        const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk, (encoding as BufferEncoding | undefined) ?? 'utf8');

        // Web streams are async; Node's write() is sync-ish. We return `true` as a pragmatic default.
        impl.stream.writer
            .write(new Uint8Array(buffer))
            .then(() => callback?.(null))
            .catch((err) => callback?.(err));

        return true;
    }

    private _webEnd(chunk?: any, encoding?: BufferEncoding | (() => void), callback?: () => void) {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = undefined;
            encoding = undefined;
        }
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }

        const impl = this[WEB_IMPL];

        if (chunk !== undefined) {
            impl.originalMethods.write(chunk, encoding as BufferEncoding);
        }

        if (!impl.headersSent) impl.originalMethods._sendHeaders();

        this._closeBodyStream().then(
            () => {
                impl.finished = true;
                callback?.();
                this.emit('finish');
            },
            (err) => {
                this.emit('error', err);
            }
        );

        return this;
    }

    private _webFlushHeaders(): void {
        const impl = this[WEB_IMPL];
        if (!impl.headersSent) impl.originalMethods._sendHeaders();
    }

    private _setHeadersFromParam(headers: OutgoingHttpHeaders | OutgoingHttpHeader[]) {
        const impl = this[WEB_IMPL];

        if (Array.isArray(headers)) {
            for (let i = 0; i < headers.length; i += 2) {
                if (i + 1 < headers.length) {
                    impl.originalMethods.setHeader(headers[i] as string, headers[i + 1] as any);
                }
            }
        } else {
            for (const [key, value] of Object.entries(headers)) {
                if (value !== undefined) impl.originalMethods.setHeader(key, value as any);
            }
        }
    }

    /**
     * Send headers and resolve the deferred Fetch Response if still pending.
     * This is called once (idempotent).
     */
    private _webSendHeaders() {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) return;

        impl.headersSent = true;

        const webHeaders = new Headers();
        for (const [key, value] of Object.entries(impl.headers)) {
            if (value === undefined) continue;

            const k = key.toLowerCase();
            if (Array.isArray(value)) {
                for (const v of value) webHeaders.append(k, String(v));
            } else {
                // For Set-Cookie, always append (never overwrite)
                if (k === 'set-cookie') webHeaders.append(k, String(value));
                else webHeaders.set(k, String(value));
            }
        }

        const status = this.statusCode || 200;
        const statusText = this.statusMessage || STATUS_CODES[status] || '';

        const isNullBodyStatus = status === 204 || status === 304 || (status >= 100 && status < 200);

        const response = isNullBodyStatus
            ? new Response(null, { status, statusText, headers: webHeaders })
            : new Response(impl.stream.readable, { status, statusText, headers: webHeaders });

        impl.responseDeferred.resolve(response);

        // Null body statuses must not have a body stream producing chunks.
        if (isNullBodyStatus) void this._closeBodyStream();
    }

    private async _closeBodyStream(): Promise<void> {
        const impl = this[WEB_IMPL];
        if (impl.stream.closed) return;
        impl.stream.closed = true;
        try {
            await impl.stream.writer.close();
        } catch {
            // Ignore close failures (e.g. consumer aborted)
        }
    }

    // --- Additional methods for Express-ish compatibility ---

    getHeaders(): OutgoingHttpHeaders {
        return { ...this[WEB_IMPL].headers };
    }

    getHeaderNames(): string[] {
        return Object.keys(this[WEB_IMPL].headers);
    }

    hasHeader(name: string): boolean {
        return name.toLowerCase() in this[WEB_IMPL].headers;
    }

    appendHeader(name: string, value: string | string[]): this {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) throw new Error('Cannot append headers after they are sent');

        const lower = name.toLowerCase();
        const existing = impl.headers[lower];

        const add = (v: string) => {
            if (existing === undefined) impl.headers[lower] = v;
            else if (Array.isArray(existing)) (existing as any).push(v);
            else impl.headers[lower] = [existing as any, v];
        };

        if (Array.isArray(value)) value.forEach(add);
        else add(value);

        return this;
    }

    addTrailers(_headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void {
        // trailers not supported
    }

    assignSocket(_socket: Socket): void {
        // no-op (we are not a real network response)
    }

    detachSocket(_socket: Socket): void {
        // no-op
    }

    writeContinue(callback?: () => void): void {
        if (callback) process.nextTick(callback);
    }

    writeEarlyHints(_hints: Record<string, string | string[]>, callback?: () => void): void {
        if (callback) process.nextTick(callback);
    }

    writeProcessing(): void {
        // no-op
    }
}

/**
 * Typed event map for our proxy server.
 */
interface WebProxyServerEventMap<
    Req extends typeof IncomingMessage = typeof IncomingMessage,
    Res extends typeof ServerResponse<InstanceType<Req>> = typeof ServerResponse
> {
    request: [InstanceType<Req>, InstanceType<Res>];
    connection: [Socket];
    connect: [InstanceType<Req>, Socket, Buffer];
    upgrade: [InstanceType<Req>, Duplex, Buffer];
    clientError: [Error, Socket];
    close: [];
    checkContinue: [InstanceType<Req>, InstanceType<Res>];
    checkExpectation: [InstanceType<Req>, InstanceType<Res>];
    listening: [];
    timeout: [];
}

/**
 * WebProxyServer
 *
 * - Accepts a Node-style RequestListener (e.g. an Express app function)
 * - Emits standard http.Server events (`request`, `upgrade`, etc.)
 * - Provides `.handle(Request|ServiceRequestEvent): Promise<Response>`
 *
 * This is not a real network server; it's an adapter to run Node middleware stacks in a Fetch environment.
 */
class WebProxyServer<
    Req extends typeof IncomingMessage = typeof IncomingMessage,
    Res extends typeof ServerResponse<InstanceType<Req>> = typeof ServerResponse,
    Listener extends RequestListener<Req, Res> | undefined = RequestListener<Req, Res>
> extends EventEmitter<WebProxyServerEventMap<Req, Res>> implements Server<Req, Res> {
    private _timeoutCallbacks: ((socket: Socket) => void)[] = [];

    constructor(public readonly listener: Listener) {
        super();
        if (this.listener) {
            // Ensure we always pass a real function to EventEmitter
            this.on('request', (req, res) => this.listener?.(req as any, res as any));
        }
    }

    // --- Server interface compatibility (minimal stubs) ---

    get keepAliveTimeoutBuffer(): number {
        return 0;
    }

    [Symbol.asyncDispose](): Promise<void> {
        return Promise.resolve();
    }

    handleUpgrade(req: InstanceType<Req>, socket: Duplex, head: Buffer) {
        this.emit('upgrade', req, socket, head);
    }

    address(): AddressInfo | string | null {
        return { port: 80, family: 'IPv4', address: '127.0.0.1' };
    }

    close(callback?: (err?: Error) => void): this {
        if (callback) process.nextTick(callback);
        this.emit('close');
        return this;
    }

    closeAllConnections(): void {}
    closeIdleConnections(): void {}

    connections: number = 0;

    getConnections(cb: (error: Error | null, count: number) => void): this {
        process.nextTick(() => cb(null, this.connections));
        return this;
    }

    headersTimeout: number = 60_000;
    keepAliveTimeout: number = 5_000;

    listen(): this {
        process.nextTick(() => this.emit('listening'));
        return this;
    }

    readonly listening: boolean = true;
    maxConnections: number = 0;
    maxHeadersCount: number | null = null;
    maxRequestsPerSocket: number | null = null;

    ref(): this {
        return this;
    }

    requestTimeout: number = 300_000;

    setTimeout(msecs?: number, callback?: (socket: Socket) => void): this;
    setTimeout(callback: (socket: Socket) => void): this;
    setTimeout(msecs?: number | ((socket: Socket) => void), callback?: (socket: Socket) => void): this {
        if (typeof msecs === 'function') {
            callback = msecs;
            msecs = undefined;
        }
        if (msecs !== undefined) this.timeout = msecs;

        if (callback) {
            this._timeoutCallbacks.push(callback);
            this.on('timeout', () => callback!(new MockSocket() as any));
        }
        return this;
    }

    timeout: number = 120_000;

    unref(): this {
        return this;
    }

    /**
     * Handle a Fetch Request (or ServiceRequestEvent) through the Node RequestListener stack
     * and return a Fetch Response.
     */
    async handle(request_or_event: Request | ServiceRequestEvent): Promise<Response> {
        const request = request_or_event instanceof Request ? request_or_event : request_or_event.request;

        const responseDeferred = new Deferred<Response>();

        const req = new WebProxyIncomingMessage(request);
        const res = new WebProxyServerResponse<WebProxyIncomingMessage>(req, responseDeferred);

        // Express expects circular references
        (req as any).res = res;
        (res as any).req = req;

        this.connections++;

        const finalize = () => {
            this.connections = Math.max(0, this.connections - 1);
        };

        res.on('finish', finalize);

        res.on('error', (err) => {
            finalize();
            if (responseDeferred.isPending) responseDeferred.reject(err);
        });

        try {
            this.emit('request', req as any, res as any);

            // Best-effort: if the listener ends synchronously without ever sending headers,
            // force sending headers so `handle()` doesn't hang forever.
            process.nextTick(() => {
                if (responseDeferred.isPending && (res as any).finished) {
                    try {
                        (res as any).flushHeaders?.();
                    } catch {
                        // ignore
                    }
                }
            });

            return await responseDeferred.promise;
        } catch (err) {
            finalize();
            if (responseDeferred.isPending) responseDeferred.reject(err);
            throw err;
        }
    }
}

// Export for use
export { WebProxyServer, WebProxyIncomingMessage, WebProxyServerResponse };
