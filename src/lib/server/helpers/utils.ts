export type Enumerate<N extends number, Acc extends number[] = []> = Acc['length'] extends N
    ? Acc[number]
    : Enumerate<N, [...Acc, Acc['length']]>;

export type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

/**
 * Create a JSON response.
 *
 * Notes:
 * - Does not set Content-Length (byte length is runtime-dependent; let the platform handle it)
 * - Safely handles null/undefined and objects with toJSON()
 */
export const json = (data: unknown, init: ResponseInit = {}): Response => {
    const body =
        data != null && typeof data === 'object' && 'toJSON' in (data as any) && typeof (data as any).toJSON === 'function'
            ? JSON.stringify((data as any).toJSON())
            : JSON.stringify(data);

    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!headers.has('Content-Length') && body.length > 0) headers.set('Content-Length', String(body.length));

    return new Response(body, {
        ...init,
        headers
    });
};

/**
 * Create a text/plain response.
 *
 * Notes:
 * - Does not set Content-Length (byte length differs from .length for UTF-8)
 */
export const text = (data: string | { toString(): string }, init: ResponseInit = {}): Response => {
    const body = data.toString();
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/plain; charset=utf-8');
    if (!headers.has('Content-Length') && body.length > 0) headers.set('Content-Length', String(body.length));

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
        if (init.filename) headers.set('Content-Disposition', `inline; filename="${init.filename}"`);
    } else {
        headers.set('Content-Type', init.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename="${init.filename}"`);
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
