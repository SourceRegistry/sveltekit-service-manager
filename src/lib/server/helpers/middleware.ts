import type {Cookies} from "@sveltejs/kit";
import type {ServiceRequestEvent} from "./../index.js";
import {isRedirectLike, isHttpErrorLike} from "./index.js";

type MaybePromise<T> = T | Promise<T>;

export type MiddlewareErrorHandler = <T>(err: unknown) => MaybePromise<T> | undefined | never | void;

const MiddlewareErrorHandle = async (e: unknown, input: MiddlewareInput) => {
    if (isRedirectLike(e) || isHttpErrorLike(e)) {
        throw e;
    } else if (typeof e === 'function') {
        return e();
    } else if (e instanceof Response) {
        return e;
    } else if (e instanceof Promise) {
        return e;
    }
    for (const errorHandler of input.errorHandlers) {
        try {
            await errorHandler(e);
        } catch (e) {
            if (typeof e === 'function') {
                return e();
            }
            throw e;
        }
    }
    throw e;
};


export type MiddlewareInput<
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
    RouteId extends string | null = string | null,
> = {
    cookies: Cookies;
    params: Params;
    route: { id: RouteId };
    url: URL;
    locals: App.Locals;
    request: Request;
    fetch: typeof fetch,
    isAction: boolean;
    callType: "method"
    get errorHandlers(): MiddlewareErrorHandler[];
}

export type MiddlewareFunction<
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
    RouteId extends string | null = string | null,
    GuardReturn = any
> = (event: MiddlewareInput<Params, RouteId>) => MaybePromise<GuardReturn>;


export type MiddlewareServiceHandler<
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
    RouteId extends string | null = string | null,
    GuardReturn extends never | any = any
> = (event: ServiceRequestEvent<Params, RouteId> & { guard: GuardReturn }) => MaybePromise<Response>;

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
        let combined: FunctionReturns = {} as FunctionReturns;
        const guardInput: MiddlewareInput<Params, RouteId> & ServiceRequestEvent<Params, RouteId> =
            Object.assign(event, {
                __errorHandlers__: [] as MiddlewareErrorHandler[],
                isAction: false,
                callType: "method",
                get errorHandlers() {
                    return this.__errorHandlers__;
                }
            } as any);
        for (const middleware of middlewares) {
            try {
                const result = await middleware(guardInput);
                combined = Object.assign(combined, result);
            } catch (e) {
                return MiddlewareErrorHandle(e, guardInput);
            }
        }
        try {
            return await handle(Object.assign(guardInput, {guard: combined}));
        } catch (e) {
            return MiddlewareErrorHandle(e, guardInput);
        }
    };
};

type Func = (...args: any[]) => any;

type ConcatReturnTypes<T extends Func[]> = T extends []
    ? NonNullable<unknown>
    : T extends [infer First, ...infer Rest]
        ? First extends Func
            ? (ReturnType<First> extends Promise<infer P> ? P : ReturnType<First>) &
            ConcatReturnTypes<Rest extends Func[] ? Rest : []>
            : NonNullable<unknown>
        : NonNullable<unknown>;
