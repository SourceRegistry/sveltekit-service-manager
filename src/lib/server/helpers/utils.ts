export type Enumerate<N extends number, Acc extends number[] = []> = Acc['length'] extends N
    ? Acc[number]
    : Enumerate<N, [...Acc, Acc['length']]>;

export type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

/**
 * Create a JSON response.
 *
 * Notes:
 * - Sets Content-Length using UTF-8 byte length
 * - Safely handles null/undefined and objects with toJSON()
 */
export const json = (data: unknown, init: ResponseInit = {}): Response => {
    const serialized =
        data != null && typeof data === 'object' && 'toJSON' in (data as any) && typeof (data as any).toJSON === 'function'
            ? JSON.stringify((data as any).toJSON())
            : JSON.stringify(data);
    const body = serialized === undefined ? 'null' : serialized;

    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!headers.has('Content-Length') && body.length > 0) headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));

    return new Response(body, {
        ...init,
        headers
    });
};

/**
 * Create a text/plain response.
 *
 * Notes:
 * - Sets Content-Length using UTF-8 byte length
 */
export const text = (data: string | { toString(): string }, init: ResponseInit = {}): Response => {
    const body = data.toString();
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/plain; charset=utf-8');
    if (!headers.has('Content-Length') && body.length > 0) headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));

    return new Response(body, {
        ...init,
        headers
    });
};

/**
 * Create a file response with Content-Disposition.
 *
 * This helper is designed for Fetch Response environments (SvelteKit/serverless/edge).
 */
export const file = (
    data: BodyInit,
    init: (
        | { mode: 'inline'; contentType: string; filename?: string }
        | { mode: 'attachment'; filename: string; contentType?: string }
        ) &
        ResponseInit
): Response => {
    const headers = new Headers(init.headers);

    if (init.mode === 'inline') {
        headers.set('Content-Type', init.contentType);
        if (init.filename) {
            const fallbackFilename = init.filename
                .replace(/[\r\n"\\]/g, '_')
                .replace(/[^\x20-\x7E]/g, '_')
                .replace(/[\\/]/g, '_');
            const encodedFilename = encodeURIComponent(init.filename).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
            headers.set('Content-Disposition', `inline; filename="${fallbackFilename}"; filename*=UTF-8''${encodedFilename}`);
        }
    } else {
        headers.set('Content-Type', init.contentType || 'application/octet-stream');
        const fallbackFilename = init.filename
            .replace(/[\r\n"\\]/g, '_')
            .replace(/[^\x20-\x7E]/g, '_')
            .replace(/[\\/]/g, '_');
        const encodedFilename = encodeURIComponent(init.filename).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        headers.set('Content-Disposition', `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodedFilename}`);
    }

    return new Response(data, {
        ...init,
        headers
    });
};

/**
 * Create a text/html response.
 */
export const html = (data: string | { toString(): string }, init: ResponseInit = {}): Response => {
    const body = data.toString();
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/html; charset=utf-8');

    return new Response(body, {...init, headers});
};

/**
 * Create a 4xx JSON response.
 */
export const fail = (
    data: unknown,
    init: Omit<ResponseInit, 'status'> & { status?: Range<400, 499> } = {}
): Response => json(data, {...init, status: init.status ?? 400});


/**
 * Create a 5xx JSON response.
 */
export const error = (
    data: unknown,
    init: Omit<ResponseInit, 'status'> & { status?: Range<500, 599> } = {}
): Response => json(data, {...init, status: init.status ?? 500});
