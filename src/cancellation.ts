import axios, { CancelToken } from 'axios'
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc'

export interface AbortError extends Error {
    name: 'AbortError'
}

/**
 * Creates an Error with name "AbortError"
 */
export const createAbortError = (): AbortError => Object.assign(new Error('Aborted'), { name: 'AbortError' as const })

/**
 * Returns true if the given value is an AbortError
 */
export const isAbortError = (err: any): err is AbortError =>
    typeof err === 'object' && err !== null && err.name === 'AbortError'

export function throwIfAbortError(err: unknown): void {
    if (isAbortError(err)) {
        throw err
    }
}

/**
 * Throws an AbortError if the given AbortSignal is already aborted
 */
export function throwIfCancelled(token: CancellationToken): void {
    if (token.isCancellationRequested) {
        throw createAbortError()
    }
}

export function tryCancel(token: CancellationTokenSource): void {
    try {
        token.cancel()
    } catch (err) {
        // ignore
    }
}

export function toAxiosCancelToken(token: CancellationToken): CancelToken {
    const source = axios.CancelToken.source()
    token.onCancellationRequested(() => source.cancel())
    return source.token
}
