export function isHttpErrorLike(error: any): error is { status: number } {
    return typeof error?.status === "number";
}

export function isRedirectLike(error: any): error is { location: string } {
    return typeof error?.location === "string";
}

