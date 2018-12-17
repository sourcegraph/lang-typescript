// Polyfill
import { URL as _URL, URLSearchParams as _URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(_URL, self.URL)
Object.assign(self, { URL: _URL, URLSearchParams: _URLSearchParams })

import { Tracer as LightstepTracer } from '@sourcegraph/lightstep-tracer-webworker'
import {
    createMessageConnection,
    MessageConnection,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import { AsyncIterableX, merge } from 'ix/asynciterable/index'
import { filter, flatMap, map, scan, tap } from 'ix/asynciterable/pipe/index'
import { fromPairs } from 'lodash'
import { Span, Tracer } from 'opentracing'
import * as sourcegraph from 'sourcegraph'
import {
    CancellationToken,
    CancellationTokenSource,
    ClientCapabilities,
    DefinitionRequest,
    Diagnostic,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    ImplementationRequest,
    InitializeParams,
    InitializeRequest,
    Location,
    LogMessageNotification,
    PublishDiagnosticsNotification,
    ReferenceParams,
    ReferencesRequest,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { getOrCreateAccessToken } from './auth'
import { Configuration } from './config'
import {
    findPackageDependentsWithNpm,
    findPackageDependentsWithSourcegraphExtensionRegistry as findDependentsWithSourcegraphExtensionRegistry,
    findPackageDependentsWithSourcegraphSearch,
    findPackageName,
} from './dependencies'
import { resolveRev, SourcegraphInstance } from './graphql'
import { Logger, LSP_TO_LOG_LEVEL, redact, RedactingLogger } from './logging'
import { convertDiagnosticToDecoration, convertHover, convertLocation, convertLocations } from './lsp-conversion'
import { WindowProgressClientCapabilities, WindowProgressNotification } from './protocol.progress.proposed'
import { canGenerateTraceUrl, logErrorEvent, sendTracedRequest, traceAsyncGenerator, tracePromise } from './tracing'
import { resolveServerRootUri, rewriteUris, toServerTextDocumentUri, toSourcegraphTextDocumentUri } from './uris'
import { asArray, distinctUntilChanged, observableFromAsyncIterable, throwIfAbortError } from './util'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

const isTypeScriptFile = (textDocumentUri: URL): boolean => /\.m?(?:t|j)sx?$/.test(textDocumentUri.hash)

const documentSelector: sourcegraph.DocumentSelector = [{ language: 'typescript' }, { language: 'javascript' }]

const logger: Logger = new RedactingLogger(console)

export async function activate(ctx: sourcegraph.ExtensionContext): Promise<void> {
    // Cancel everything whene extension is deactivated
    const cancellationTokenSource = new CancellationTokenSource()
    ctx.subscriptions.add(() => cancellationTokenSource.cancel())
    const token = cancellationTokenSource.token

    const config = sourcegraph.configuration.get().value as Configuration
    const tracer: Tracer = config['lightstep.token']
        ? new LightstepTracer({ access_token: config['lightstep.token'], component_name: 'ext-lang-typescript' })
        : new Tracer()

    const accessToken = await getOrCreateAccessToken()

    const decorationType = sourcegraph.app.createDecorationType()

    /** Adds the access token to the given server raw HTTP API URI, if available */
    function authenticateUri(uri: URL): URL {
        const authenticatedUri = new URL(uri.href)
        if (accessToken) {
            authenticatedUri.username = accessToken
        }
        return authenticatedUri
    }

    /**
     * @param rootUri The server HTTP root URI
     */
    async function connect(
        rootUri: URL,
        { span, token }: { span: Span; token: CancellationToken }
    ): Promise<MessageConnection> {
        return await tracePromise('Connect to language server', tracer, span, async span => {
            const serverUrl: unknown = sourcegraph.configuration.get().get('typescript.serverUrl')
            if (typeof serverUrl !== 'string') {
                throw new Error(
                    'Setting typescript.serverUrl must be set to the WebSocket endpoint of the TypeScript language service'
                )
            }
            const socket = new WebSocket(serverUrl)
            ctx.subscriptions.add(() => socket.close())
            socket.addEventListener('close', event => {
                logger.warn('WebSocket connection to TypeScript backend closed', event)
            })
            socket.addEventListener('error', event => {
                logger.error('WebSocket error', event)
            })
            const rpcWebSocket = toSocket(socket)
            const connection = createMessageConnection(
                new WebSocketMessageReader(rpcWebSocket),
                new WebSocketMessageWriter(rpcWebSocket),
                logger
            )
            ctx.subscriptions.add(() => connection.dispose())
            connection.onNotification(LogMessageNotification.type, ({ type, message }) => {
                // Blue background for the "TypeScript server" prefix
                const method = LSP_TO_LOG_LEVEL[type]
                const args = [
                    new Date().toLocaleTimeString() + ' %cTypeScript backend%c %s',
                    'background-color: blue; color: white',
                    '',
                    message,
                ]
                logger[method](...args)
            })
            // Display diagnostics as decorations
            /** Diagnostic by Sourcegraph text document URI */
            const diagnosticsByUri = new Map<string, Diagnostic[]>()
            connection.onNotification(PublishDiagnosticsNotification.type, params => {
                const uri = new URL(params.uri)
                const sourcegraphTextDocumentUri = toSourcegraphTextDocumentUri(uri)
                diagnosticsByUri.set(sourcegraphTextDocumentUri.href, params.diagnostics)
                for (const appWindow of sourcegraph.app.windows) {
                    for (const viewComponent of appWindow.visibleViewComponents) {
                        if (viewComponent.document.uri === sourcegraphTextDocumentUri.href) {
                            viewComponent.setDecorations(
                                decorationType,
                                params.diagnostics.map(convertDiagnosticToDecoration)
                            )
                        }
                    }
                }
            })
            ctx.subscriptions.add(
                sourcegraph.workspace.onDidOpenTextDocument.subscribe(() => {
                    for (const appWindow of sourcegraph.app.windows) {
                        for (const viewComponent of appWindow.visibleViewComponents) {
                            const diagnostics = diagnosticsByUri.get(viewComponent.document.uri) || []
                            viewComponent.setDecorations(decorationType, diagnostics.map(convertDiagnosticToDecoration))
                        }
                    }
                })
            )
            // Show progress reports
            const progressReporters = new Map<string, Promise<sourcegraph.ProgressReporter>>()
            connection.onNotification(
                WindowProgressNotification.type,
                async ({ id, title, message, percentage, done }) => {
                    try {
                        if (!sourcegraph.app.activeWindow || !sourcegraph.app.activeWindow.showProgress) {
                            return
                        }
                        let reporterPromise = progressReporters.get(id)
                        if (!reporterPromise) {
                            reporterPromise = sourcegraph.app.activeWindow.showProgress({ title })
                            progressReporters.set(id, reporterPromise)
                        }
                        const reporter = await reporterPromise
                        reporter.next({ percentage, message })
                        if (done) {
                            reporter.complete()
                            progressReporters.delete(id)
                        }
                    } catch (err) {
                        logger.error('Error handling progress notification', err)
                    }
                }
            )
            connection.listen()
            const event = await new Promise<Event>(resolve => {
                socket.addEventListener('open', resolve, { once: true })
                socket.addEventListener('error', resolve, { once: true })
            })
            if (event.type === 'error') {
                throw new Error(`The WebSocket to the TypeScript backend at ${serverUrl} could not not be opened`)
            }
            logger.log(`WebSocket connection to TypeScript backend at ${serverUrl} opened`)
            const clientCapabilities: ClientCapabilities & WindowProgressClientCapabilities = {
                experimental: {
                    progress: true,
                },
            }
            const initializeParams: InitializeParams = {
                processId: 0,
                rootUri: rootUri.href,
                workspaceFolders: [{ name: '', uri: rootUri.href }],
                capabilities: clientCapabilities,
                initializationOptions: {
                    // until workspace/configuration is allowed during initialize
                    configuration: {
                        // The server needs to use the API to resolve repositories
                        'sourcegraph.url': sourcegraph.internal.sourcegraphURL.toString(),
                        ...fromPairs(
                            Object.entries(sourcegraph.configuration.get().value).filter(([key]) =>
                                key.startsWith('typescript.')
                            )
                        ),
                    },
                },
            }
            logger.log('Initializing TypeScript backend...')
            await sendTracedRequest(connection, InitializeRequest.type, initializeParams, {
                span,
                tracer,
                token,
            })
            logger.log('TypeScript backend initialized')
            // Tell language server about all currently open text documents under this root
            for (const textDocument of sourcegraph.workspace.textDocuments) {
                if (!isTypeScriptFile(new URL(textDocument.uri))) {
                    continue
                }
                const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(new URL(textDocument.uri)))
                if (!serverTextDocumentUri.href.startsWith(rootUri.href)) {
                    continue
                }
                const didOpenParams: DidOpenTextDocumentParams = {
                    textDocument: {
                        uri: serverTextDocumentUri.href,
                        languageId: textDocument.languageId,
                        text: textDocument.text,
                        version: 1,
                    },
                }
                connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
            }
            return connection
        })
    }

    /**
     * @param rootUri The server HTTP root URI
     */
    async function getOrCreateConnection(
        rootUri: URL,
        { span, token }: { span: Span; token: CancellationToken }
    ): Promise<MessageConnection> {
        return await tracePromise('Get or create connection', tracer, span, async span => {
            let connectionPromise = connectionsByRootUri.get(rootUri.href)
            if (!connectionPromise) {
                connectionPromise = connect(
                    rootUri,
                    { span, token }
                )
                connectionsByRootUri.set(rootUri.href, connectionPromise)
            }
            const connection = await connectionPromise
            connection.onClose(() => {
                connectionsByRootUri.delete(rootUri.href)
            })
            return connection
        })
    }

    // Forward didOpen notifications
    ctx.subscriptions.add(
        sourcegraph.workspace.onDidOpenTextDocument.subscribe(async textDocument => {
            try {
                await tracePromise('Handle didOpenTextDocument', tracer, undefined, async span => {
                    if (canGenerateTraceUrl(span)) {
                        logger.log('didOpen trace', span.generateTraceURL())
                    }
                    const textDocumentUri = new URL(textDocument.uri)
                    if (!isTypeScriptFile(textDocumentUri)) {
                        return
                    }

                    const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                    const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                    const connection = await getOrCreateConnection(serverRootUri, { token, span })
                    const didOpenParams: DidOpenTextDocumentParams = {
                        textDocument: {
                            uri: serverTextDocumentUri.href,
                            languageId: textDocument.languageId,
                            text: textDocument.text,
                            version: 1,
                        },
                    }
                    connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
                })
            } catch (err) {
                logger.error('Error handling didOpenTextDocument event', err)
            }
        })
    )

    const areProviderParamsEqual = (
        [doc1, pos1]: [sourcegraph.TextDocument, sourcegraph.Position],
        [doc2, pos2]: [sourcegraph.TextDocument, sourcegraph.Position]
    ): boolean => doc1.uri === doc2.uri && pos1.isEqual(pos2)

    // Hover
    ctx.subscriptions.add(
        sourcegraph.languages.registerHoverProvider(documentSelector, {
            provideHover: distinctUntilChanged(areProviderParamsEqual, (textDocument, position) =>
                tracePromise('Provide hover', tracer, undefined, async span => {
                    if (canGenerateTraceUrl(span)) {
                        logger.log('Hover trace', span.generateTraceURL())
                    }
                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                    const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                    const connection = await getOrCreateConnection(serverRootUri, { span, token })
                    const hoverResult = await sendTracedRequest(
                        connection,
                        HoverRequest.type,
                        {
                            textDocument: { uri: serverTextDocumentUri.href },
                            position,
                        },
                        { span, tracer, token }
                    )
                    rewriteUris(hoverResult, toSourcegraphTextDocumentUri)
                    return convertHover(hoverResult)
                })
            ),
        })
    )

    // Definition
    ctx.subscriptions.add(
        sourcegraph.languages.registerDefinitionProvider(documentSelector, {
            provideDefinition: distinctUntilChanged(areProviderParamsEqual, (textDocument, position) =>
                tracePromise('Provide definition', tracer, undefined, async span => {
                    if (canGenerateTraceUrl(span)) {
                        logger.log('Definition trace', span.generateTraceURL())
                    }
                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                    const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                    const connection = await getOrCreateConnection(serverRootUri, { span, token })
                    const definitionResult = await sendTracedRequest(
                        connection,
                        DefinitionRequest.type,
                        {
                            textDocument: { uri: serverTextDocumentUri.href },
                            position,
                        },
                        { span, tracer, token }
                    )
                    rewriteUris(definitionResult, toSourcegraphTextDocumentUri)
                    return convertLocations(definitionResult)
                })
            ),
        })
    )

    // References
    const provideReferences = (
        textDocument: sourcegraph.TextDocument,
        position: sourcegraph.Position,
        context: sourcegraph.ReferenceContext
    ): AsyncIterable<sourcegraph.Location[]> =>
        traceAsyncGenerator('Provide references', tracer, undefined, async function*(span) {
            if (canGenerateTraceUrl(span)) {
                logger.log('References trace', span.generateTraceURL())
            }
            const textDocumentUri = new URL(textDocument.uri)
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri, { span, token })

            const findLocalReferences = () =>
                traceAsyncGenerator('Find local references', tracer, span, async function*(span) {
                    logger.log('Searching for same-repo references')
                    const localReferences = asArray(
                        await sendTracedRequest(
                            connection,
                            ReferencesRequest.type,
                            {
                                textDocument: { uri: serverTextDocumentUri.href },
                                position,
                                context,
                            },
                            { span, tracer, token }
                        )
                    )
                    logger.log(`Found ${localReferences.length} same-repo references`)
                    yield localReferences
                })

            const findExternalReferences = () =>
                traceAsyncGenerator('Find external references', tracer, span, async function*(span) {
                    logger.log('Getting canonical definition for cross-repo references')
                    const definition: Location | undefined = asArray(
                        await sendTracedRequest(
                            connection,
                            DefinitionRequest.type,
                            {
                                textDocument: { uri: serverTextDocumentUri.href },
                                position,
                            },
                            { span, tracer, token }
                        )
                    )[0]
                    if (!definition) {
                        return
                    }
                    span.setTag('uri', redact(definition.uri))
                    span.setTag('line', definition.range.start.line)

                    const instanceUrl = new URL(sourcegraph.internal.sourcegraphURL.toString())
                    const sgInstance: SourcegraphInstance = {
                        accessToken,
                        instanceUrl,
                    }
                    const findPackageDependents =
                        instanceUrl.hostname === 'sourcegraph.com'
                            ? findPackageDependentsWithNpm
                            : findPackageDependentsWithSourcegraphSearch

                    logger.log(`Getting external references for definition`, definition)

                    const definitionUri = new URL(definition.uri)

                    const referenceParams: ReferenceParams = {
                        textDocument: { uri: definitionUri.href },
                        position: definition.range.start,
                        context,
                    }

                    const packageName = await findPackageName(definitionUri, { logger, tracer, span })

                    // Find dependent packages on the package
                    const dependents =
                        packageName === 'sourcegraph'
                            ? // If the package name is "sourcegraph", we are looking for references to a symbol in the Sourcegraph extension API
                              // Extensions are not published to npm, so search the extension registry
                              findDependentsWithSourcegraphExtensionRegistry(sgInstance, {
                                  logger,
                                  tracer,
                                  span,
                              })
                            : findPackageDependents(packageName, sgInstance, { logger, tracer, span })

                    // Search for references in each dependent
                    if (!sourcegraph.app.activeWindow) {
                        return
                    }
                    const reporter = await sourcegraph.app.activeWindow.showProgress({
                        title: 'Searching dependents for references',
                    })
                    try {
                        const findExternalReferencesInDependent = (repoName: string) =>
                            traceAsyncGenerator('Find external references in dependent', tracer, span, async function*(
                                span
                            ) {
                                try {
                                    reporter.next({ message: repoName })
                                    span.setTag('repoName', repoName)
                                    const commitID = await resolveRev(repoName, 'HEAD', sgInstance, {
                                        span,
                                        tracer,
                                    })
                                    const dependentRootUri = authenticateUri(
                                        new URL(`${repoName}@${commitID}/-/raw/`, instanceUrl)
                                    )
                                    logger.log(`Looking for external references in dependent repo ${repoName}`)
                                    const dependentConnection = await getOrCreateConnection(dependentRootUri, {
                                        span,
                                        token,
                                    })
                                    const referencesInDependent = asArray(
                                        await sendTracedRequest(
                                            dependentConnection,
                                            ReferencesRequest.type,
                                            referenceParams,
                                            {
                                                span,
                                                tracer,
                                                token,
                                            }
                                        )
                                    )
                                    logger.log(
                                        `Found ${referencesInDependent.length} references in dependent repo ${repoName}`
                                    )
                                    yield referencesInDependent
                                } catch (err) {
                                    throwIfAbortError(err)
                                    logErrorEvent(span, err)
                                    logger.error(`Error searching dependent repo "${repoName}" for references`, err)
                                }
                            })
                        yield* AsyncIterableX.from(dependents).pipe(flatMap(findExternalReferencesInDependent))
                        reporter.complete()
                    } catch (e) {
                        reporter.error(e)
                    }
                    logger.log('Done going through dependents')
                })

            yield* merge(findLocalReferences(), findExternalReferences()).pipe(
                // Same-repo references
                // Cross-repo references
                // Find canonical source location
                filter(chunk => chunk.length > 0),
                tap({
                    next: chunk => {
                        span.log({ event: 'chunk', count: chunk.length })
                    },
                }),
                // Rewrite URIs and convert from LSP to Sourcegraph Location
                map(chunk =>
                    chunk
                        .map(location => {
                            try {
                                return convertLocation({
                                    ...location,
                                    uri: toSourcegraphTextDocumentUri(new URL(location.uri)).href,
                                })
                            } catch (err) {
                                return undefined
                            }
                        })
                        .filter((location): location is Exclude<typeof location, undefined> => !!location)
                ),
                // Aggregate individual chunks into a growing array (which is what Sourcegraph expects)
                scan<sourcegraph.Location[], sourcegraph.Location[]>(
                    (allReferences, chunk) => allReferences.concat(chunk),
                    []
                )
            )
        })
    ctx.subscriptions.add(
        sourcegraph.languages.registerReferenceProvider(documentSelector, {
            provideReferences: (doc, pos, ctx) => observableFromAsyncIterable(provideReferences(doc, pos, ctx)),
        })
    )

    // Implementations
    ctx.subscriptions.add(
        sourcegraph.languages.registerImplementationProvider(documentSelector, {
            provideImplementation: (textDocument, position) =>
                tracePromise('Provide implementations', tracer, undefined, async span => {
                    if (canGenerateTraceUrl(span)) {
                        logger.log('Implementation trace', span.generateTraceURL())
                    }
                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                    const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                    const connection = await getOrCreateConnection(serverRootUri, { span, token })
                    const implementationParams: TextDocumentPositionParams = {
                        textDocument: { uri: serverTextDocumentUri.href },
                        position,
                    }
                    const implementationResult = await sendTracedRequest(
                        connection,
                        ImplementationRequest.type,
                        implementationParams,
                        { span, tracer, token }
                    )
                    rewriteUris(implementationResult, toSourcegraphTextDocumentUri)
                    return convertLocations(implementationResult)
                }),
        })
    )
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
