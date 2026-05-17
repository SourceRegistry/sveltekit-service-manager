import {isHttpError, isRedirect} from '@sveltejs/kit';

export function isHttpErrorLike(error: any): error is { status: number } {
    return isHttpError(error);
}

export function isRedirectLike(error: any): error is { location: string } {
    return isRedirect(error);
}

