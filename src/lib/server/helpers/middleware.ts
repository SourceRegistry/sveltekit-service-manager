import type { Cookies } from '@sveltejs/kit';
import type { ServiceRequestEvent } from './../index.js';
import { isRedirectLike, isHttpErrorLike } from './index.js';

type MaybePromise<T> = T | Promise<T>;

/**
 * Error handler for middleware pipelines.
 *
 * If it returns a Response, the pipeline will short-circuit and return it.
 * If it throws, the thrown value is re-processed by the pipeline error handling.
 * If it returns void/undefined, the pipeline continues to the next error handler.
 */
export type MiddlewareErrorHandler = (err: unknown) => MaybePromise<Response | void | undefined>;

/**
 * Common input shape exposed to middleware functions.
 *
 * This intentionally mirrors key parts of SvelteKit's RequestEvent plus extra metadata.
 */
export type MiddlewareInput<
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
    RouteId extends string | null = string | null
> = {
    cookies: Cookies;
    params: Params;
    route: { id: RouteId };
    url: URL;
    locals: App.Locals;
    request: Request;
    fetch: typeof fetch;
    isAction: boolean;
    callType: 'method';
    get errorHandlers(): MiddlewareErrorHandler[];
};

/**
 * A middleware function can compute/return an object ("guard") merged into the final handler context.
 *
 * Returning `undefined` is allowed (no changes).
 */
export type MiddlewareFunction<
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
    RouteId extends string | null = string | null,
    GuardReturn = any
> = (event: MiddlewareInput<Params, RouteId>) => MaybePromise<GuardReturn | void | undefined>;

/**
 * Final handler that receives the merged guard object on `event.guard`.
 */
export type MiddlewareServiceHandler<
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
    RouteId extends string | null = string | null,
    GuardReturn = any
> = (event: ServiceRequestEvent<Params, RouteId> & { guard: GuardReturn }) => MaybePromise<Response>;

type Func = (...args: any[]) => any;

type ConcatReturnTypes<T extends Func[]> = T extends []
    ? NonNullable<unknown>
    : T extends [infer First, ...infer Rest]
        ? First extends Func
            ? (ReturnType<First> extends Promise<infer P> ? P : ReturnType<First>) &
            ConcatReturnTypes<Rest extends Func[] ? Rest : []>
            : NonNullable<unknown>
        : NonNullable<unknown>;

/**
 * Internal: resolves errors for middleware/handler execution.
 *
 * Rules:
 * - Redirect-like / HttpError-like are rethrown (so upstream SvelteKit can handle them)
 * - If a middleware throws a Response, return it
 * - If a middleware throws a function, call it (and await it)
 * - Otherwise, call registered error handlers in order; if any returns a Response, return it
 * - If none handled it, rethrow the original error
 */
const handleMiddlewareError = async (err: unknown, input: { errorHandlers: MiddlewareErrorHandler[] }) => {
    if (isRedirectLike(err) || isHttpErrorLike(err)) {
        throw err;
    }

    // Allow "throw new Response(...)" style short-circuit
    if (err instanceof Response) return err;

    // Allow "throw () => new Response(...)" style short-circuit
    if (typeof err === 'function') {
        const result = (err as () => unknown)();
        return result instanceof Response ? result : await (result as any);
    }

    for (const errorHandler of input.errorHandlers) {
        try {
            const maybe = await errorHandler(err);
            if (maybe instanceof Response) return maybe;
        } catch (e2) {
            // Re-run the error resolution on the thrown value
            return handleMiddlewareError(e2, input);
        }
    }

    throw err;
};

/**
 * Compose a service handler with one or more middleware functions.
 *
 * Middleware functions run in order. Each may return an object to be merged into `event.guard`.
 * If any middleware throws/returns a Response via error handling, the pipeline short-circuits.
 */
export const middleware = <
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
    RouteId extends string | null = string | null,
    Functions extends MiddlewareFunction<Params, RouteId, object>[] = MiddlewareFunction<Params, RouteId, object>[],
    FunctionReturns extends Awaited<ConcatReturnTypes<Functions>> = Awaited<ConcatReturnTypes<Functions>>
>(
    handle: MiddlewareServiceHandler<Params, RouteId, FunctionReturns>,
    ...middlewares: Functions
) => {
    return async (event: ServiceRequestEvent<Params, RouteId>): Promise<Response> => {
        // IMPORTANT: do NOT mutate the incoming event object.
        const errorHandlers: MiddlewareErrorHandler[] = [];

        const guardInput: MiddlewareInput<Params, RouteId> & ServiceRequestEvent<Params, RouteId> = {
            ...event,
            isAction: false,
            callType: 'method',
            get errorHandlers() {
                return errorHandlers;
            }
        } as any;

        let combined = {} as FunctionReturns;

        for (const mw of middlewares) {
            try {
                const result = await mw(guardInput);

                // Only merge object-like returns
                if (result && typeof result === 'object') {
                    combined = Object.assign(combined, result);
                }
            } catch (e) {
                return await handleMiddlewareError(e, guardInput);
            }
        }

        try {
            return await handle(Object.assign(guardInput, { guard: combined }));
        } catch (e) {
            return await handleMiddlewareError(e, guardInput);
        }
    };
};
