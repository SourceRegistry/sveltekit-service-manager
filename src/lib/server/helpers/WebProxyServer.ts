import { EventEmitter } from 'events';
import { Socket } from 'net';
import {
    IncomingMessage,
    ServerResponse,
    type OutgoingHttpHeaders,
    type OutgoingHttpHeader,
    Server,
    type RequestListener
} from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'node:stream';
import type { ServiceRequestEvent } from '../index.js';

/**
 * A deferred promise implementation that allows external resolution/rejection
 */
class Deferred<T = void> {
    public readonly promise: Promise<T>;
    public resolve!: (value: T | PromiseLike<T>) => void;
    public reject!: (reason?: any) => void;

    private _isResolved = false;
    private _isRejected = false;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = (value: T | PromiseLike<T>) => {
                if (!this._isResolved && !this._isRejected) {
                    this._isResolved = true;
                    resolve(value);
                }
            };

            this.reject = (reason?: any) => {
                if (!this._isResolved && !this._isRejected) {
                    this._isRejected = true;
                    reject(reason);
                }
            };
        });
    }

    /**
     * Returns true if the promise has been resolved
     */
    get isResolved(): boolean {
        return this._isResolved;
    }

    /**
     * Returns true if the promise has been rejected
     */
    get isRejected(): boolean {
        return this._isRejected;
    }

    /**
     * Returns true if the promise is still pending
     */
    get isPending(): boolean {
        return !this._isResolved && !this._isRejected;
    }

    /**
     * Returns true if the promise has been settled (resolved or rejected)
     */
    get isSettled(): boolean {
        return this._isResolved || this._isRejected;
    }

    step<TResult2 = never>(): [onfulfilled?: ((value: T) => T | PromiseLike<T>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null]{
        return [
            (r) => {
                this.resolve(r);
                return r;
            },
            (reason) => {
                this.reject(reason);
                return reason;
            }
        ]
    }

}


// Mock socket for compatibility
class MockSocket extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;

    address() {
        return { port: 80, family: 'IPv4', address: '127.0.0.1' };
    }

    destroy() {
        this.destroyed = true;
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

// Symbol to store our Web API implementation
const WEB_IMPL = Symbol('webImpl');

class WebProxyIncomingMessage extends IncomingMessage {
    // Store our implementation in a symbol to avoid conflicts
    [WEB_IMPL]: {
        body: ReadableStream<Uint8Array> | null;
        bodyReader: ReadableStreamDefaultReader<Uint8Array> | null;
        isReading: boolean;
    };

    constructor(request: Request) {
        // Create a mock socket first
        const mockSocket = new MockSocket() as any;

        // Call parent constructor with mock socket
        super(mockSocket);

        // Extract URL and method
        const url = new URL(request.url);
        this.url = url.pathname + url.search;
        this.method = request.method;

        // Convert headers
        this.headers = {};
        this.rawHeaders = [];
        this.headersDistinct = {};

        request.headers.forEach((value, key) => {
            const lowerKey = key.toLowerCase();
            this.headers[lowerKey] = value;
            this.headersDistinct[lowerKey] = [value];
            this.rawHeaders.push(key, value);
        });

        // Set other properties
        this.httpVersion = '1.1';
        this.httpVersionMajor = 1;
        this.httpVersionMinor = 1;
        this.complete = true;
        this.aborted = false;
        this.rawTrailers = [];
        this.trailers = {};
        this.trailersDistinct = {};

        // Store Web API implementation
        this[WEB_IMPL] = {
            body: request.body,
            bodyReader: null,
            isReading: false
        };

        // Start reading body if present
        if (request.body) {
            this._startBodyReading();
        } else {
            // No body, end immediately
            process.nextTick(() => {
                this.push(null);
            });
        }
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
                    this.push(null); // End of stream
                    break;
                }

                if (!this.push(Buffer.from(value))) {
                    // Backpressure - wait for drain
                    await new Promise(resolve => this.once('drain', resolve));
                }
            }
        } catch (error) {
            this.destroy(error as Error);
        } finally {
            impl.isReading = false;
        }
    }

    _read() {
        // This will be called by the Readable stream
        // Body reading is handled by _startBodyReading
    }

    // Override setTimeout to ensure it returns this for chaining
    setTimeout(msecs: number, callback?: () => void): this {
        if (callback) {
            setTimeout(callback, msecs);
        }
        return this;
    }
}

class WebProxyServerResponse<Request extends IncomingMessage = IncomingMessage> extends ServerResponse<Request> {
    // Store our Web API implementation
    [WEB_IMPL]: {
        headers: OutgoingHttpHeaders;
        chunks: Buffer[];
        headersSent: boolean;
        finished: boolean;
        writer: WritableStreamDefaultWriter<Uint8Array> | null;
        responseDeferred: Deferred<Response>;
        // Store original methods to prevent Express from overriding them
        originalMethods: {
            setHeader: (name: string, value: number | string | readonly string[]) => void;
            getHeader: (name: string) => number | string | string[] | undefined;
            removeHeader: (name: string) => void;
            writeHead: (statusCode: number, statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[], headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]) => void;
            write: (chunk: any, encoding?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) => boolean;
            end: (chunk?: any, encoding?: BufferEncoding | (() => void), callback?: () => void) => WebProxyServerResponse<Request>;
            _sendHeaders: () => void;
        };
    };
    private locals: any;

    constructor(req: Request, responseDeferred: Deferred<Response>) {
        // Create mock socket
        const mockSocket = new MockSocket() as any;

        // Call parent constructor
        super(req);
        super.assignSocket(mockSocket);

        // Initialize locals for Express compatibility
        this.locals = Object.create(null);

        // Store Web API implementation with original methods
        this[WEB_IMPL] = {
            headers: {},
            chunks: [],
            headersSent: false,
            finished: false,
            writer: null,
            responseDeferred,
            originalMethods: {
                setHeader: this._webSetHeader.bind(this),
                getHeader: this._webGetHeader.bind(this),
                removeHeader: this._webRemoveHeader.bind(this),
                writeHead: this._webWriteHead.bind(this),
                write: this._webWrite.bind(this),
                end: this._webEnd.bind(this),
                _sendHeaders: this._webSendHeaders.bind(this)
            }
        };

        // Override critical methods that Express might call
        this._setupWebApiIntegration();
    }

    private _setupWebApiIntegration() {
        const impl = this[WEB_IMPL];

        // Override with non-enumerable properties so Express prototype doesn't override them
        Object.defineProperty(this, 'setHeader', {
            value: impl.originalMethods.setHeader,
            writable: false,
            enumerable: false,
            configurable: false
        });

        Object.defineProperty(this, 'getHeader', {
            value: impl.originalMethods.getHeader,
            writable: false,
            enumerable: false,
            configurable: false
        });

        Object.defineProperty(this, 'removeHeader', {
            value: impl.originalMethods.removeHeader,
            writable: false,
            enumerable: false,
            configurable: false
        });

        Object.defineProperty(this, 'writeHead', {
            value: impl.originalMethods.writeHead,
            writable: false,
            enumerable: false,
            configurable: false
        });

        Object.defineProperty(this, 'write', {
            value: impl.originalMethods.write,
            writable: false,
            enumerable: false,
            configurable: false
        });

        Object.defineProperty(this, 'end', {
            value: impl.originalMethods.end,
            writable: false,
            enumerable: false,
            configurable: false
        });

        // Also define _sendHeaders to prevent Express from overriding it
        Object.defineProperty(this, '_sendHeaders', {
            value: impl.originalMethods._sendHeaders,
            writable: false,
            enumerable: false,
            configurable: false
        });

        // Override headersSent and finished as getters
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
        if (impl.headersSent) {
            throw new Error('Cannot set headers after they are sent');
        }
        // @ts-ignore
        impl.headers[name.toLowerCase()] = value;
        // Call original for Node.js compatibility
        return super.setHeader(name, value);
    }

    private _webGetHeader(name: string) {
        return this[WEB_IMPL].headers[name.toLowerCase()];
    }

    private _webRemoveHeader(name: string) {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) {
            throw new Error('Cannot remove headers after they are sent');
        }
        delete impl.headers[name.toLowerCase()];
        super.removeHeader(name);
    }

    private _webWriteHead(statusCode: number, statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[], headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]) {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) {
            throw new Error('Cannot set headers after they are sent');
        }

        this.statusCode = statusCode;

        if (typeof statusMessageOrHeaders === 'string') {
            this.statusMessage = statusMessageOrHeaders;
            if (headers) {
                this._setHeadersFromParam(headers);
            }
        } else if (statusMessageOrHeaders) {
            this._setHeadersFromParam(statusMessageOrHeaders);
        }

        impl.originalMethods._sendHeaders();
        return this;
    }

    private _webWrite(chunk: any, encoding?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) {
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = 'utf8';
        }

        const impl = this[WEB_IMPL];
        if (impl.finished) {
            if (callback) callback(new Error('Cannot write after end'));
            return false;
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as BufferEncoding || 'utf8');

        if (impl.headersSent) {
            // Headers already sent, write directly to stream
            if (impl.writer) {
                impl.writer.write(new Uint8Array(buffer)).then(() => {
                    if (callback) callback(null);
                }).catch(callback);
            } else {
                if (callback) callback(new Error('No writer available'));
                return false;
            }
        } else {
            // Buffer until headers are sent
            impl.chunks.push(buffer);
            if (callback) process.nextTick(callback);
        }

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

        if (!impl.headersSent) {
            impl.originalMethods._sendHeaders();
        }

        if (impl.writer) {
            impl.writer.close().then(() => {
                impl.finished = true;
                if (callback) callback();
                this.emit('finish');
            }).catch((error: Error) => {
                this.emit('error', error);
            });
        } else {
            impl.finished = true;
            if (callback) callback();
            this.emit('finish');
        }

        return this;
    }

    private _setHeadersFromParam(headers: OutgoingHttpHeaders | OutgoingHttpHeader[]) {
        if (Array.isArray(headers)) {
            for (let i = 0; i < headers.length; i += 2) {
                if (i + 1 < headers.length) {
                    this[WEB_IMPL].originalMethods.setHeader(headers[i] as string, headers[i + 1]);
                }
            }
        } else {
            Object.entries(headers).forEach(([key, value]) => {
                if (value !== undefined) {
                    this[WEB_IMPL].originalMethods.setHeader(key, value);
                }
            });
        }
    }

    private _webSendHeaders() {
        const impl = this[WEB_IMPL];
        if (impl.headersSent) return;

        impl.headersSent = true;

        // Convert headers to Web API format
        const webHeaders = new Headers();
        Object.entries(impl.headers).forEach(([key, value]) => {
            if (Array.isArray(value)) {
                value.forEach(v => webHeaders.append(key, String(v)));
            } else if (value !== undefined) {
                webHeaders.set(key, String(value));
            }
        });

        // Handle null body status codes that are not allowed by Web API Response constructor
        const nullBodyStatuses = [204, 304];
        const isNullBodyStatus = nullBodyStatuses.includes(this.statusCode);

        // Get default status text helper function
        const getDefaultStatusText = (statusCode: number): string => {
            const statusTexts: Record<number, string> = {
                200: 'OK',
                201: 'Created',
                204: 'No Content',
                301: 'Moved Permanently',
                302: 'Found',
                304: 'Not Modified',
                400: 'Bad Request',
                401: 'Unauthorized',
                403: 'Forbidden',
                404: 'Not Found',
                405: 'Method Not Allowed',
                500: 'Internal Server Error',
                502: 'Bad Gateway',
                503: 'Service Unavailable'
            };
            return statusTexts[statusCode] || 'Unknown Status';
        };

        let response: Response;

        if (isNullBodyStatus) {
            // For null body statuses, create response without body
            response = new Response(null, {
                status: this.statusCode,
                statusText: this.statusMessage || getDefaultStatusText(this.statusCode),
                headers: webHeaders
            });

            // Close the writer immediately since there's no body
            if (impl.writer) {
                impl.writer.close().catch(err => {
                    this.emit('error', err);
                });
            }
        } else {
            // Create ReadableStream for response body
            const { readable, writable } = new TransformStream();
            const writer = writable.getWriter();
            impl.writer = writer;

            // Write any buffered chunks
            if (impl.chunks.length > 0) {
                const buffer = Buffer.concat(impl.chunks);
                writer.write(new Uint8Array(buffer)).catch(err => {
                    this.emit('error', err);
                });
                impl.chunks = [];
            }

            // Create the Response
            response = new Response(readable, {
                status: this.statusCode,
                statusText: this.statusMessage || getDefaultStatusText(this.statusCode),
                headers: webHeaders
            });
        }

        impl.responseDeferred.resolve(response);
    }



    // Additional methods for Express compatibility
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
        if (impl.headersSent) {
            throw new Error('Cannot append headers after they are sent');
        }

        const lowerName = name.toLowerCase();
        const existing = impl.headers[lowerName];

        if (existing === undefined) {
            // @ts-ignore
            impl.headers[lowerName] = value;
        } else if (Array.isArray(existing)) {
            if (Array.isArray(value)) {
                existing.push(...value);
            } else {
                // @ts-ignore
                existing.push(value);
            }
        } else {
            if (Array.isArray(value)) {
                impl.headers[lowerName] = [existing as string, ...value];
            } else {
                impl.headers[lowerName] = [existing as string, value];
            }
        }
        return this;
    }

    // No-op methods for Express compatibility
    addTrailers(headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void {
    }

    assignSocket(socket: Socket): void {
    }

    detachSocket(socket: Socket): void {
    }

    flushHeaders(): void {
        if (!this[WEB_IMPL].headersSent) {
            this[WEB_IMPL].originalMethods._sendHeaders();
        }
    }

    writeContinue(callback?: () => void): void {
        if (callback) process.nextTick(callback);
    }

    writeEarlyHints(hints: Record<string, string | string[]>, callback?: () => void): void {
        if (callback) process.nextTick(callback);
    }

    writeProcessing(): void {
    }
}

// Event map for the server
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

class WebProxyServer<
    Req extends typeof IncomingMessage = typeof IncomingMessage,
    Res extends typeof ServerResponse<InstanceType<Req>> = typeof ServerResponse,
    Listener extends RequestListener<Req, Res> | undefined = RequestListener<Req, Res>
> extends EventEmitter<WebProxyServerEventMap<Req, Res>> implements Server<Req, Res> {

    private _timeoutCallbacks: ((socket: Socket) => void)[] = [];

    constructor(public readonly listener: Listener) {
        super();
        if (this.listener) {
            /**
             * @reason The listener is passed into a function because proxy function objects are not compatible with EventEmitter
             * @error TypeError [ERR_INVALID_ARG_TYPE]: The "listener" argument must be of type function. Received an instance of Object
             */
            this.on('request', (req,res) => this.listener?.(req, res));
        }
    }

    get keepAliveTimeoutBuffer(): number{
        throw new Error("Method not implemented.");
    };
    [Symbol.asyncDispose](): Promise<void> {
        throw new Error("Method not implemented.");
    }

    handleUpgrade(req: InstanceType<Req>, socket: Duplex, head: Buffer){
        this.emit('upgrade',req, socket, head);
    }

    address(): AddressInfo | string | null {
        return { port: 80, family: 'IPv4', address: '127.0.0.1' };
    }

    close(callback?: (err?: Error) => void): this {
        if (callback) process.nextTick(callback);
        this.emit('close');
        return this;
    }

    closeAllConnections(): void {
    }

    closeIdleConnections(): void {
    }

    connections: number = 0;

    getConnections(cb: (error: Error | null, count: number) => void): this {
        process.nextTick(() => cb(null, this.connections));
        return this;
    }

    headersTimeout: number = 60000;
    keepAliveTimeout: number = 5000;

    listen(): this {
        process.nextTick(() => {
            this.emit('listening');
        });
        return this;
    }

    readonly listening: boolean = true;
    maxConnections: number = 0;
    maxHeadersCount: number | null = null;
    maxRequestsPerSocket: number | null = null;

    ref(): this {
        return this;
    }

    requestTimeout: number = 300000;

    // Fixed setTimeout method with proper overloads
    setTimeout(msecs?: number, callback?: (socket: Socket) => void): this;
    setTimeout(callback: (socket: Socket) => void): this;
    setTimeout(msecs?: number | ((socket: Socket) => void), callback?: (socket: Socket) => void): this {
        if (typeof msecs === 'function') {
            // First overload: setTimeout(callback)
            callback = msecs;
            msecs = undefined;
        }

        if (msecs !== undefined) {
            this.timeout = msecs;
        }

        if (callback) {
            this._timeoutCallbacks.push(callback);
            this.on('timeout', () => {
                // Create a mock socket for the callback
                const mockSocket = new MockSocket() as any;
                callback(mockSocket);
            });
        }

        return this;
    }

    timeout: number = 120000;

    unref(): this {
        return this;
    }

    async handle(request_or_event: Request | ServiceRequestEvent): Promise<Response> {

        let request: Request;
        if (!(request_or_event instanceof Request)) request = request_or_event.request;
        else request = request_or_event as Request;


        const responseDeferred = new Deferred<Response>();

        try {
            // Create Express-compatible request and response objects
            const req = new WebProxyIncomingMessage(request);
            const res = new WebProxyServerResponse<WebProxyIncomingMessage>(req, responseDeferred);

            // Set up the circular references that Express expects
            (req as any).res = res;
            (res as any).req = req;

            // Increment connection count
            this.connections++;

            // Emit the request event (Express app will handle this)
            this.emit('request', req as InstanceType<Req>, res as InstanceType<Res>);

            // Set up cleanup when response finishes
            res.on('finish', () => {
                this.connections--;
            });

            // Handle errors
            res.on('error', (error) => {
                this.connections--;
                if (!responseDeferred.promise) {
                    responseDeferred.reject(error);
                }
            });

            return await responseDeferred.promise;
        } catch (error) {
            this.connections--;
            throw error;
        }
    }
}

// Export for use
export { WebProxyServer, WebProxyIncomingMessage, WebProxyServerResponse };
