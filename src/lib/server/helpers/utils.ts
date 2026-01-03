export type Enumerate<N extends number, Acc extends number[] = []> = Acc['length'] extends N
    ? Acc[number]
    : Enumerate<N, [...Acc, Acc['length']]>

export type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>

export const json = (data: any | { toJSON(): any }, init?: ResponseInit) => {
    const _data = JSON.stringify('toJSON' in data ? data.toJSON() : data);
    return new Response(_data, {
        status: init?.status ?? 200,
        statusText: init?.statusText ?? 'OK',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': _data.length.toString(),
            ...init?.headers
        }
    })
};

export const text = (data: string | { toString(): string }, init?: ResponseInit) => {
    return new Response(data.toString(), {
        status: init?.status ?? 200,
        statusText: init?.statusText ?? 'OK',
        headers: {
            'Content-Type': 'text/plain',
            'Content-Length': data.toString().length.toString(),
            ...init?.headers
        }
    })
};

export const file = (
    data: BodyInit,
    init: (
        | { mode: 'inline'; contentType: string; filename?: string }
        | { mode: 'attachment'; filename: string; contentType?: string }
        ) & RequestInit
): Response => {
    // Normalize headers — safely handle Headers | string[][] | Record<string, string>
    const headers = new Headers(init?.headers);

    if (init.mode === 'inline') {
        headers.set('Content-Type', init.contentType);
        if (init.filename) {
            headers.set('Content-Disposition', `inline; filename="${init.filename}"`);
        }
    } else if (init.mode === 'attachment') {
        headers.set('Content-Type', init.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename="${init.filename}"`);
    }

    // Return new Response — don't mutate original init
    return new Response(data, {
        ...init,
        headers
    })
        ;
};

export const fail = (data: any | { toJSON(): any }, init?: Omit<ResponseInit, 'status'> & {
    status: Range<400, 499>
}) => json(data, init ?? {status: 400});

export const error = (data: any | { toJSON(): any }, init?: Omit<ResponseInit, 'status'> & {
    status: Range<500, 599>
}) => json(data, init ?? {status: 500});
