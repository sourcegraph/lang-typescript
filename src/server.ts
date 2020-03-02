import 'source-map-support/register'

// Polyfill
import { AbortController } from 'abort-controller'
Object.assign(global, { AbortController })

import {
    createMessageConnection,
    IWebSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import * as rpcServer from '@sourcegraph/vscode-ws-jsonrpc/lib/server'
import axios from 'axios'
import express from 'express'
import { highlight } from 'highlight.js'
import * as http from 'http'
import * as https from 'https'
import * as ini from 'ini'
import 'ix'
import { from, merge } from 'ix/asynciterable'
import { from as iterableFrom, IterableX } from 'ix/iterable'
import { Tracer as LightstepTracer } from 'lightstep-tracer'
import { noop } from 'lodash'
import mkdirp from 'mkdirp-promise'
import * as fs from 'mz/fs'
import { FORMAT_HTTP_HEADERS, Span, Tracer } from 'opentracing'
import { HTTP_URL, SPAN_KIND, SPAN_KIND_RPC_CLIENT, SPAN_KIND_RPC_SERVER } from 'opentracing/lib/ext/tags'
import { tmpdir } from 'os'
import * as path from 'path'
import prettyBytes from 'pretty-bytes'
import * as prometheus from 'prom-client'
import rmfr from 'rmfr'
import { interval, Unsubscribable } from 'rxjs'
import { NullableMappedPosition, RawSourceMap, SourceMapConsumer } from 'source-map'
import { extract, FileStat } from 'tar'
import * as type from 'type-is'
import { fileURLToPath, pathToFileURL, URL } from 'url'
import { inspect } from 'util'
import * as uuid from 'uuid'
import {
    CancellationToken,
    ClientCapabilities,
    CodeActionParams,
    CodeActionRequest,
    Definition,
    DefinitionRequest,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    ImplementationRequest,
    InitializeParams,
    InitializeRequest,
    InitializeResult,
    Location,
    LocationLink,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    Range,
    ReferencesRequest,
    TextDocumentPositionParams,
    TypeDefinitionRequest,
} from 'vscode-languageserver-protocol'
import { Server } from 'ws'
import { throwIfCancelled, toAxiosCancelToken } from './cancellation'
import { Settings } from './config'
import {
    cloneUrlFromPackageMeta,
    fetchPackageMeta,
    filterDependencies,
    findClosestPackageJson,
    findPackageRootAndName,
    readPackageJson,
    resolveDependencyRootDir,
} from './dependencies'
import { createDispatcher, createRequestDurationMetric, RequestType } from './dispatcher'
import { AsyncDisposable, Disposable, disposeAllAsync } from './disposable'
import { resolveRepository } from './graphql'
import { flatMapConcurrent } from './ix'
import { LanguageServer, spawnLanguageServer } from './language-server'
import { Logger, LSPLogger, MultiLogger, PrefixedLogger, redact, RedactingLogger } from './logging'
import { createProgressProvider, noopProgressProvider, ProgressProvider } from './progress'
import { WindowProgressClientCapabilities } from './protocol.progress.proposed'
import {
    createResourceRetrieverPicker,
    FileResourceRetriever,
    HttpResourceRetriever,
    ResourceNotFoundError,
    walkUp,
} from './resources'
import { tracePromise } from './tracing'
import { sanitizeTsConfigs } from './tsconfig'
import { relativeUrl, URLMap, URLSet } from './uri'
import { install } from './yarn'

const globalLogger = new RedactingLogger(console)

process.on('uncaughtException', err => {
    globalLogger.error('Uncaught exception:', err)
    process.exit(1)
})

const CACHE_DIR = process.env.CACHE_DIR || fs.realpathSync(tmpdir())
globalLogger.log(`Using CACHE_DIR ${CACHE_DIR}`)

let tracer = new Tracer()
if (process.env.LIGHTSTEP_ACCESS_TOKEN) {
    globalLogger.log('LightStep tracing enabled')
    tracer = new LightstepTracer({
        access_token: process.env.LIGHTSTEP_ACCESS_TOKEN,
        component_name: 'lang-typescript',
    })
}

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080

let httpServer: http.Server | https.Server
if (process.env.TLS_CERT && process.env.TLS_KEY) {
    globalLogger.log('TLS encryption enabled')
    httpServer = https.createServer({
        cert: process.env.TLS_CERT,
        key: process.env.TLS_KEY,
    })
} else {
    httpServer = http.createServer()
}

/** Disposables to be disposed when the whole server is shutting down */
const globalDisposables = new Set<Disposable | AsyncDisposable>()

// Cleanup when receiving signals
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    process.once(signal, async () => {
        globalLogger.log(`Received ${signal}, cleaning up`)
        await disposeAllAsync(globalDisposables)
        process.exit(0)
    })
}

const webSocketServer = new Server({ server: httpServer })
globalDisposables.add({ dispose: () => webSocketServer.close() })

const openConnectionsMetric = new prometheus.Gauge({
    name: 'typescript_open_websocket_connections',
    help: 'Open WebSocket connections to the TypeScript server',
})
const requestDurationMetric = createRequestDurationMetric()
prometheus.collectDefaultMetrics()

const isTypeScriptFile = (path: string): boolean => /((\.d)?\.[tj]sx?|json)$/.test(path)

const pickResourceRetriever = createResourceRetrieverPicker([new HttpResourceRetriever(), new FileResourceRetriever()])

const TYPESCRIPT_DIR_URI = pathToFileURL(path.resolve(__dirname, '..', '..', 'node_modules', 'typescript') + '/')
const TYPESCRIPT_VERSION = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'node_modules', 'typescript', 'package.json'), 'utf-8')
).version
globalLogger.log(`Using TypeScript version ${TYPESCRIPT_VERSION} from ${TYPESCRIPT_DIR_URI}`)

webSocketServer.on('connection', connection => {
    const connectionId = uuid.v1()
    openConnectionsMetric.set(webSocketServer.clients.size)
    globalLogger.log(`New WebSocket connection ${connectionId}, ${webSocketServer.clients.size} open`)

    /** Functions to run when this connection is closed (or the server shuts down) */
    const connectionDisposables = new Set<AsyncDisposable | Disposable | Unsubscribable>()
    {
        const connectionDisposable: AsyncDisposable = {
            disposeAsync: async () => await disposeAllAsync([...connectionDisposables].reverse()),
        }
        globalDisposables.add(connectionDisposable)
        connectionDisposables.add({ dispose: () => globalDisposables.delete(connectionDisposable) })
        const closeListener = async (code: number, reason: string) => {
            openConnectionsMetric.set(webSocketServer.clients.size)
            globalLogger.log(`WebSocket closed: ${connectionId}, ${webSocketServer.clients.size} open`, {
                code,
                reason,
            })
            await connectionDisposable.disposeAsync()
        }
        connection.on('close', closeListener)
        connectionDisposables.add({ dispose: () => connection.removeListener('close', closeListener) })
    }

    const webSocket: IWebSocket = {
        onMessage: handler => connection.on('message', handler),
        onClose: handler => connection.on('close', handler),
        onError: handler => connection.on('error', handler),
        send: content => connection.send(content),
        dispose: () => connection.close(),
    }
    connectionDisposables.add(webSocket)
    const webSocketReader = new WebSocketMessageReader(webSocket)
    connectionDisposables.add(webSocketReader)
    const webSocketWriter = new WebSocketMessageWriter(webSocket)
    connectionDisposables.add(webSocketWriter)
    const webSocketConnection = rpcServer.createConnection(webSocketReader, webSocketWriter, noop)
    const webSocketMessageConnection = createMessageConnection(
        webSocketConnection.reader,
        webSocketConnection.writer,
        globalLogger
    )
    const logger: Logger = new PrefixedLogger(
        new MultiLogger([globalLogger, new RedactingLogger(new LSPLogger(webSocketMessageConnection))]),
        `conn ${connectionId}`
    )
    const connectionLogger = logger

    // Periodically send ping/pong messages
    // to check if connection is still alive
    let alive = true
    connection.on('pong', () => {
        logger.log('Got pong')
        alive = true
    })
    logger.log('WebSocket open')
    connectionDisposables.add(
        interval(30000).subscribe(() => {
            try {
                if (!alive) {
                    logger.log('Terminating WebSocket')
                    connection.terminate()
                }
                alive = false
                if (connection.readyState === connection.OPEN) {
                    connection.ping()
                }
            } catch (err) {
                logger.error('Ping error', err)
            }
        })
    )
    connection.ping()

    // Connection state set on initialize
    let languageServer: LanguageServer
    /** The initialize params passed to the typescript language server */
    let serverInitializeParams: InitializeParams
    let configuration: Settings
    let tempDir: string
    let tempDirUri: URL
    let httpRootUri: URL
    let fileRootUri: URL
    let extractPath: string
    let tsserverCacheDir: string
    // yarn folders
    let globalFolderRoot: string
    let cacheFolderRoot: string
    /** HTTP URIs for directories in the workspace that contain a package.json (and are not inside node_modules) */
    let packageRootUris: URLSet
    /** Map from HTTP URI for directory of package.json to Promise for its installation */
    const dependencyInstallationPromises = new URLMap<Promise<void>>()
    /** HTTP URIs of directories with package.jsons in the workspace that finished installation */
    const finishedDependencyInstallations = new URLSet()
    /** Map from file URIs of text documents that were sent didOpen for to mapped TextDocumentDidOpenParams */
    const openTextDocuments = new URLMap<DidOpenTextDocumentParams>()

    const dispatcher = createDispatcher(webSocketConnection, {
        requestDurationMetric,
        logger,
        tracer,
        tags: {
            connectionId,
            [SPAN_KIND]: SPAN_KIND_RPC_SERVER,
        },
    })
    connectionDisposables.add({ dispose: () => dispatcher.dispose() })

    let withProgress: ProgressProvider = noopProgressProvider

    /** Checks if the given URI is under the root URI */
    const isInWorkspace = (resource: URL): boolean => resource.href.startsWith(httpRootUri.href)

    /**
     * Maps TextDocumentPositionParams with a http URI to one with a file URI.
     * If the http URI is out-of-workspace (ouside the rootUri), it attempts to map it to a file: URI within node_modules.
     *
     * @param incomingUri Example: `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts`
     */
    async function mapTextDocumentPositionParams(
        params: TextDocumentPositionParams,
        { span, token }: { span: Span; token: CancellationToken }
    ): Promise<TextDocumentPositionParams> {
        return await tracePromise('Map parameters to file location', tracer, span, async span => {
            throwIfCancelled(token)
            const incomingUri = new URL(params.textDocument.uri)
            if (isInWorkspace(incomingUri)) {
                // In-workspace URI, do a simple rewrite from http to file URI
                return {
                    textDocument: {
                        uri: mapHttpToFileUrlSimple(incomingUri).href,
                    },
                    position: params.position,
                }
            }

            // URI is an out-of-workspace URI (a URI from a different project)
            // This external project may exist in the form of a dependency in node_modules
            // Find the closest package.json to it to figure out the package name
            const [packageRoot, packageName] = await findPackageRootAndName(incomingUri, pickResourceRetriever, {
                span,
                tracer,
            })
            // Run yarn install for all package.jsons that contain the dependency we are looking for
            logger.log(`Installing dependencies for all package.jsons that depend on "${packageName}"`)
            await Promise.all(
                iterableFrom(packageRootUris).map(async packageRootUri => {
                    const pkgJsonUri = new URL('package.json', packageRootUri)
                    const pkgJson = await readPackageJson(pkgJsonUri, pickResourceRetriever, { span, tracer })
                    if (
                        (pkgJson.dependencies && pkgJson.dependencies.hasOwnProperty(packageName)) ||
                        (pkgJson.devDependencies && pkgJson.devDependencies.hasOwnProperty(packageName))
                    ) {
                        logger.log(`package.json at ${packageRootUri} has dependency on "${packageName}", installing`)
                        await Promise.all([
                            ensureDependenciesForPackageRoot(packageRootUri, { tracer, span, token }),
                            (async () => {
                                const filePackageRoot = mapHttpToFileUrlSimple(packageRootUri)
                                // tsserver is unable to find references from projects that don't have at least one file open.
                                // To find global references to a file in node_modules, open one random TypeScript file
                                // of every tsconfig.json containing or contained by a package depending on the package
                                const tsconfigPattern = new URL('**/tsconfig.json', filePackageRoot)
                                const projectRoots = merge(
                                    // Find any tsconfig in child directories of the package root (and the package root itself)
                                    pickResourceRetriever(tsconfigPattern).glob(tsconfigPattern, {
                                        ignore: ['**/node_modules'],
                                    }),
                                    // Find any tsconfig in parent directories of the package root
                                    from(walkUp(filePackageRoot)).filter(async dir => {
                                        const tsconfigUri = new URL('tsconfig.json', dir)
                                        return await pickResourceRetriever(tsconfigUri).exists(tsconfigUri)
                                    })
                                )
                                await flatMapConcurrent(projectRoots, 10, async function*(
                                    projectRoot
                                ): AsyncGenerator<never, void, void> {
                                    const pattern = new URL('**/*.ts?(x)', projectRoot)
                                    // Find a random TS file in the project and open it
                                    const typescriptFile = await from(
                                        pickResourceRetriever(pattern).glob(pattern)
                                    ).first()
                                    logger.log(`Opening ${typescriptFile} to trigger project load of ${projectRoot}`)
                                    if (typescriptFile) {
                                        await openTextDocument(typescriptFile)
                                    }
                                }).toArray()
                            })(),
                        ])
                    }
                })
            )

            const packageRootRelativePath = relativeUrl(packageRoot, incomingUri)

            // Check if the file already exists somewhere in node_modules
            // This is the case for non-generated declaration files (including @types/ packages) and packages that ship sources (e.g. ix)
            {
                const patternUrl = new URL(
                    path.posix.join(`**/node_modules/${packageName}`, packageRootRelativePath),
                    tempDirUri
                )
                const file = await from(
                    pickResourceRetriever(patternUrl).glob(patternUrl, {
                        span,
                        tracer,
                    })
                ).first()
                if (file) {
                    const mappedParams = {
                        position: params.position,
                        textDocument: {
                            uri: file.href,
                        },
                    }
                    logger.log(`Found file ${incomingUri} in node_modules at ${file}`)
                    logger.log('Mapped params', params, 'to', mappedParams)
                    return mappedParams
                }
            }

            // If the incoming URI is already a declaration file, abort
            if (incomingUri.pathname.endsWith('.d.ts')) {
                throw new Error(`Incoming declaration file ${incomingUri} does not exist in workspace's node_modules`)
            }
            // If the incoming URI is not a declaration file and does not exist in node_modules,
            // it is a source file that needs to be mapped to a declaration file using a declaration map
            // Find all .d.ts.map files in the package
            logger.log(
                `Looking for declaration maps to map source file ${incomingUri} to declaration file in node_modules`
            )
            const patternUrl = new URL(`**/node_modules/${packageName}/**/*.d.ts.map`, tempDirUri)
            const declarationMapUrls = from(pickResourceRetriever(patternUrl).glob(patternUrl, { span, tracer }))
            const mappedParams = await flatMapConcurrent(declarationMapUrls, 10, async function*(declarationMapUrl) {
                try {
                    const declarationMap: RawSourceMap = JSON.parse(
                        await pickResourceRetriever(declarationMapUrl).fetch(declarationMapUrl, { span, tracer })
                    )
                    const packageRootPath = resolveDependencyRootDir(fileURLToPath(declarationMapUrl))
                    const packageRootFileUrl = pathToFileURL(packageRootPath + '/')
                    const sourceFileUrl = new URL(packageRootRelativePath, packageRootFileUrl)
                    // Check if any of the sources of this source file matches the source file we are looking for
                    if (
                        !declarationMap.sources.some(
                            source => new URL(source, declarationMapUrl).href === sourceFileUrl.href
                        )
                    ) {
                        return
                    }
                    logger.log(`Declaration map ${declarationMapUrl} matches source ${sourceFileUrl}`)
                    const declarationFile = new URL(declarationMap.file, declarationMapUrl)
                    // Use the source map to match the location in the source file to the location in the .d.ts file
                    const consumer = await new SourceMapConsumer(declarationMap, declarationMapUrl.href)
                    try {
                        const declarationPosition = consumer.generatedPositionFor({
                            source: sourceFileUrl.href,
                            // LSP is 0-based, source maps are 1-based line numbers
                            line: params.position.line + 1,
                            column: params.position.character,
                        })
                        if (declarationPosition.line === null || declarationPosition.column === null) {
                            const { line, character } = params.position
                            throw new Error(
                                `Could not map source position ${sourceFileUrl}:${line}:${character} to position in declaration file`
                            )
                        }
                        yield {
                            textDocument: {
                                uri: declarationFile.href,
                            },
                            position: {
                                line: declarationPosition.line - 1,
                                character: declarationPosition.column,
                            },
                        }
                    } finally {
                        consumer.destroy()
                    }
                } catch (err) {
                    logger.error(`Error processing declaration map ${declarationMapUrl}`, err)
                }
            }).first()
            if (!mappedParams) {
                throw new Error(`Could not find out-of-workspace URI ${incomingUri} in workspace's dependencies`)
            }
            return mappedParams
        })
    }
    function mapHttpToFileUrlSimple(uri: URL): URL {
        const relative = relativeUrl(httpRootUri, uri)
        const fileUri = new URL(relative, fileRootUri.href)
        // Security check to prevent access from one connection into
        // other files on the container or other connection's directories
        if (!fileUri.href.startsWith(fileRootUri.href)) {
            throw new Error(`URI ${uri} is not under rootUri ${httpRootUri}`)
        }
        return fileUri
    }
    /**
     * Converts the given `file:` URI to an HTTP URI rooted at the `rootUri`.
     *
     * @throws If resource is in node_modules
     */
    function mapFileToHttpUrlSimple(uri: URL): URL {
        const relativePath = relativeUrl(fileRootUri, uri)
        if (relativePath.includes('node_modules/')) {
            throw new Error(`Can't map URI ${uri} to HTTP URL because it is in node_modules`)
        }
        const httpUri = new URL(relativePath, httpRootUri.href)
        if (!httpUri.href.startsWith(httpRootUri.href)) {
            // Should never happen, since these are outgoing URIs
            // Sanity check against bugs (e.g. not realpath()ing the temp dir)
            throw new Error(`URI ${httpUri} is not under rootUri ${httpRootUri}`)
        }
        return httpUri
    }

    // tsserver often doesn't properly catch all files added by dependency installation.
    // For safety, we restart it after dependencies were installed.
    async function restartLanguageServer({
        span,
        token,
    }: {
        span: Span
        token: CancellationToken
    }): Promise<InitializeResult> {
        // Kill old language server instance
        if (languageServer) {
            connectionDisposables.delete(languageServer)
            languageServer.dispose()
        }
        languageServer = await spawnLanguageServer({
            tempDir,
            tsserverCacheDir,
            configuration,
            connectionId,
            tracer,
            logger,
        })
        connectionDisposables.add(languageServer)
        connectionDisposables.add(
            languageServer.errors.subscribe(err => {
                logger.error('Launching language server failed', err)
                connection.close()
            })
        )
        // Forward diagnostics
        if (configuration['typescript.diagnostics.enable']) {
            connectionDisposables.add(
                languageServer.dispatcher.observeNotification(PublishDiagnosticsNotification.type).subscribe(params => {
                    try {
                        if (params.uri.includes('/node_modules/')) {
                            return
                        }
                        const mappedParams: PublishDiagnosticsParams = {
                            ...params,
                            uri: mapFileToHttpUrlSimple(new URL(params.uri)).href,
                        }
                        webSocketMessageConnection.sendNotification(PublishDiagnosticsNotification.type, mappedParams)
                    } catch (err) {
                        logger.error(
                            `Error handling ${PublishDiagnosticsNotification.type.method} notification`,
                            params,
                            err
                        )
                    }
                })
            )
        }
        // Initialize it again with same InitializeParams
        const initializeResult = await sendServerRequest(InitializeRequest.type, serverInitializeParams, {
            tracer,
            span,
            token,
        })
        // Replay didOpen notifications
        for (const didOpenParams of openTextDocuments.values()) {
            languageServer.connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
        }
        return initializeResult
    }

    dispatcher.setRequestHandler(InitializeRequest.type, async (params, token, span) => {
        if (!params.rootUri) {
            throw new Error('No rootUri given as initialize parameter')
        }
        logger.log(`rootUri ${params.rootUri}`)
        if (params.workspaceFolders && params.workspaceFolders.length > 1) {
            throw new Error(
                'More than one workspace folder given. The TypeScript server only supports a single workspace folder.'
            )
        }
        httpRootUri = new URL(params.rootUri)
        span.setTag('rootUri', httpRootUri.href)
        if (httpRootUri.protocol !== 'http:' && httpRootUri.protocol !== 'https:') {
            throw new Error('rootUri protocol must be http or https, got ' + httpRootUri)
        }

        // Workaround until workspace/configuration is allowed during initialize
        if (params.initializationOptions && params.initializationOptions.configuration) {
            configuration = params.initializationOptions.configuration
        }

        const capabilities = params.capabilities as ClientCapabilities & WindowProgressClientCapabilities
        if (
            capabilities.experimental &&
            capabilities.experimental.progress &&
            configuration['typescript.progress'] !== false
        ) {
            // Client supports reporting progress
            withProgress = createProgressProvider(webSocketMessageConnection, logger)
        }

        // Create temp folders
        tempDir = path.join(CACHE_DIR, connectionId)
        tempDirUri = pathToFileURL(tempDir + '/')
        await mkdirp(tempDir)
        connectionDisposables.add({
            disposeAsync: async () => {
                globalLogger.log('Deleting temp dir ', tempDir)
                await rmfr(tempDir)
            },
        })
        extractPath = path.join(tempDir, 'repo')
        cacheFolderRoot = path.join(tempDir, 'cache')
        globalFolderRoot = path.join(tempDir, 'global')
        tsserverCacheDir = path.join(tempDir, 'tsserver_cache')
        await Promise.all([
            fs.mkdir(tsserverCacheDir),
            fs.mkdir(extractPath),
            fs.mkdir(cacheFolderRoot),
            fs.mkdir(globalFolderRoot),
            (async () => {
                if (configuration['typescript.npmrc']) {
                    await fs.writeFile(path.join(tempDir, '.npmrc'), ini.stringify(configuration['typescript.npmrc']))
                }
            })(),
        ])

        // Fetch tar and extract into temp folder
        /** Detected paths to package.jsons (that are not in node_modules) */
        const packageJsonPaths: string[] = []
        logger.info('Fetching archive from', httpRootUri.href)
        logger.log('Extracting to', extractPath)
        await tracePromise('Fetch source archive', tracer, span, async span => {
            await withProgress('Loading TypeScript project', async reporter => {
                span.setTag(HTTP_URL, redact(httpRootUri.href))
                const headers = {
                    Accept: 'application/x-tar',
                    'User-Agent': 'TypeScript language server',
                }
                span.tracer().inject(span, FORMAT_HTTP_HEADERS, headers)
                const response = await axios.get<NodeJS.ReadableStream>(httpRootUri.href, {
                    headers,
                    responseType: 'stream',
                    cancelToken: toAxiosCancelToken(token),
                })
                const contentType = response.headers['content-type']
                if (!type.is(contentType, 'application/*')) {
                    throw new Error(`Expected response to be of content type application/x-tar, was ${contentType}`)
                }
                const contentLength: number | undefined =
                    response.headers['content-length'] && +response.headers['content-length']
                logger.log('Archive size:', contentLength && prettyBytes(contentLength))
                let bytes = 0
                await new Promise<void>((resolve, reject) => {
                    response.data
                        .on('error', reject)
                        .on('data', (chunk: Buffer) => {
                            bytes += chunk.byteLength
                            if (contentLength) {
                                reporter.next({ percentage: bytes / contentLength })
                            }
                        })
                        .pipe(extract({ cwd: extractPath, filter: isTypeScriptFile }))
                        .on('entry', (entry: FileStat) => {
                            if (
                                entry.header.path &&
                                entry.header.path.endsWith('package.json') &&
                                // Make sure to not capture package.json inside checked-in node_modules
                                !entry.header.path.split('/').includes('node_modules')
                            ) {
                                packageJsonPaths.push(entry.header.path)
                            }
                        })
                        .on('warn', warning => logger.warn(warning))
                        .on('finish', resolve)
                        .on('error', reject)
                })
                span.setTag('bytes', bytes)
            })
        })

        // Find package.jsons to install
        throwIfCancelled(token)
        logger.log('package.jsons found:', packageJsonPaths)
        packageRootUris = new URLSet(
            packageJsonPaths.map(packageJsonPath => new URL(path.dirname(packageJsonPath) + '/', httpRootUri.href))
        )

        // Sanitize tsconfig.json files
        await sanitizeTsConfigs({ dir: pathToFileURL(extractPath), pickResourceRetriever, logger, tracer, span, token })

        // The trailing slash is important for resolving URL relatively to it
        fileRootUri = pathToFileURL(extractPath + '/')
        // URIs are rewritten by rewriteUris below, but it doesn't touch rootPath
        serverInitializeParams = { ...params, rootPath: extractPath, rootUri: fileRootUri.href }

        // Spawn language server
        return await restartLanguageServer({ span, token })
    })

    /**
     * Returns all known package.json directories that are an ancestor of the given URI (and therefor should be installed to provide codeintel on this URI).
     *
     * @param uri The HTTP URL of a text document
     * @return HTTP URLs of package.json directories
     */
    const findParentPackageRoots = (uri: URL): IterableX<URL> =>
        iterableFrom(packageRootUris).filter(packageRoot => uri.href.startsWith(packageRoot.href))

    async function installDependenciesForPackage(
        packageRootUri: URL,
        { tracer, span, token }: { tracer: Tracer; span?: Span; token: CancellationToken }
    ): Promise<void> {
        await tracePromise('Install dependencies for package', tracer, span, async span => {
            span.setTag('packageRoot', packageRootUri)
            const relPackageRoot = relativeUrl(httpRootUri, packageRootUri)
            const logger = new PrefixedLogger(connectionLogger, 'install ' + relPackageRoot)
            try {
                const absPackageJsonPath = path.join(extractPath, relPackageRoot, 'package.json')
                const npmConfig = configuration['typescript.npmrc'] || {}
                const hasDeps = await filterDependencies(absPackageJsonPath, { npmConfig, logger, tracer, span, token })
                if (!hasDeps) {
                    return
                }
                // It's important that each concurrent yarn process has their own global and cache folders
                const globalFolder = path.join(globalFolderRoot, relPackageRoot)
                const cacheFolder = path.join(cacheFolderRoot, relPackageRoot)
                const cwd = path.join(extractPath, relPackageRoot)
                await Promise.all([mkdirp(path.join(globalFolder)), mkdirp(path.join(cacheFolder))])
                await install({ cwd, globalFolder, cacheFolder, logger, tracer, span, token, withProgress })
                await sanitizeTsConfigs({
                    dir: pathToFileURL(path.join(cwd, 'node_modules')),
                    pickResourceRetriever,
                    logger,
                    tracer,
                    span,
                    token,
                })
                if (configuration['typescript.restartAfterDependencyInstallation'] !== false) {
                    await restartLanguageServer({ span, token })
                }
            } catch (err) {
                throwIfCancelled(token)
                logger.error('Installation failed', err)
            } finally {
                finishedDependencyInstallations.add(packageRootUri)
            }
        })
    }

    async function ensureDependenciesForPackageRoot(
        packageRootUri: URL,
        { tracer, span, token }: { tracer: Tracer; span?: Span; token: CancellationToken }
    ): Promise<void> {
        let installationPromise = dependencyInstallationPromises.get(packageRootUri)
        if (!installationPromise) {
            installationPromise = installDependenciesForPackage(packageRootUri, { tracer, span, token })
            // Save Promise so requests can wait for the installation to finish
            dependencyInstallationPromises.set(packageRootUri, installationPromise)
        }
        await installationPromise
    }

    /**
     * Ensures dependencies for all package.jsons in parent directories of the given text document were installed.
     * Errors will be caught and logged.
     *
     * @param textDocumentUri The HTTP text document URI that dependencies should be installed for
     * @throws never
     */
    async function ensureDependenciesForDocument(
        textDocumentUri: URL,
        { tracer, span, token = CancellationToken.None }: { tracer: Tracer; span?: Span; token?: CancellationToken }
    ): Promise<void> {
        await tracePromise('Ensure dependencies', tracer, span, async span => {
            throwIfCancelled(token)
            const parentPackageRoots = findParentPackageRoots(textDocumentUri)
            span.setTag('packageJsonLocations', parentPackageRoots.map(String))
            logger.log(`Ensuring dependencies for text document ${textDocumentUri} defined in`, [
                ...parentPackageRoots.map(String),
            ])
            await Promise.all(
                parentPackageRoots.map(async packageRoot => {
                    await ensureDependenciesForPackageRoot(packageRoot, { tracer, span, token })
                })
            )
        })
    }

    /**
     * Sends a request to the language server with support for OpenTracing (wrapping the request in a span)
     */
    async function sendServerRequest<P, R>(
        type: RequestType<P, R>,
        params: P,
        { tracer, span, token }: { tracer: Tracer; span: Span; token: CancellationToken }
    ): Promise<R> {
        return await tracePromise('Request ' + type.method, tracer, span, async span => {
            span.setTag(SPAN_KIND, SPAN_KIND_RPC_CLIENT)
            const result = await languageServer.connection.sendRequest(type, params, token)
            // logger.log(`Got result for ${type.method}`, params, result)
            return result
        })
    }

    dispatcher.setRequestHandler(HoverRequest.type, async (params, token, span) => {
        // Map the http URI in params to file URIs
        const mappedParams = await mapTextDocumentPositionParams(params, { span, token })
        const result = await sendServerRequest(HoverRequest.type, mappedParams, { token, tracer, span })
        // Heuristic: If the hover contained an `any` type or shows the definition at the `import` line,
        // start dependency installation in the background
        // This is not done on file open because tsserver can get busy with handling all the file change events
        // It's expected that the client polls to get an updated hover content once dependency installation finished
        if (/\b(any|import)\b/.test(JSON.stringify(result))) {
            // tslint:disable-next-line:no-floating-promises
            ensureDependenciesForDocument(new URL(params.textDocument.uri), { tracer, span, token })
        }
        return result
    })

    /**
     * Maps Locations returned as a result from a definition, type definition, implementation or references call to HTTP URLs
     * and potentially to external repositories if the location is in node_modules.
     *
     * @param location A location on the file system (with a `file:` URI)
     */
    async function mapFileLocation(location: Location, { token }: { token: CancellationToken }): Promise<Location> {
        const fileUri = new URL(location.uri)
        // Check if file path is in TypeScript lib
        // If yes, point to Microsoft/TypeScript GitHub repo
        if (fileUri.href.startsWith(TYPESCRIPT_DIR_URI.href)) {
            const relativeFilePath = relativeUrl(TYPESCRIPT_DIR_URI, fileUri)
            // TypeScript git tags their releases, but has no gitHead field.
            const typescriptUrl = new URL(
                `https://sourcegraph.com/github.com/Microsoft/TypeScript@v${TYPESCRIPT_VERSION}/-/raw/${relativeFilePath}`
            )
            return { uri: typescriptUrl.href, range: location.range }
        }
        // Check if file path is inside a node_modules dir
        // If it is inside node_modules, that means the file is out-of-workspace, i.e. outside of the HTTP root URI
        // We return an HTTP URL to the client that the client can access
        if (fileUri.pathname.includes('/node_modules/')) {
            try {
                const [, packageJson] = await findClosestPackageJson(fileUri, pickResourceRetriever, tempDirUri)
                if (!packageJson.repository) {
                    throw new Error(`Package ${packageJson.name} has no repository field`)
                }
                let cloneUrl = cloneUrlFromPackageMeta(packageJson)
                let subdir = ''
                // Handle GitHub tree URLs
                const treeMatch = cloneUrl.match(
                    /^(?:https?:\/\/)?(?:www\.)?github.com\/[^\/]+\/[^\/]+\/tree\/[^\/]+\/(.+)$/
                )
                if (treeMatch) {
                    subdir = treeMatch[1]
                    cloneUrl = cloneUrl.replace(/(\/tree\/[^\/]+)\/.+/, '$1')
                }
                if (typeof packageJson.repository === 'object' && packageJson.repository.directory) {
                    subdir = packageJson.repository.directory
                } else if (packageJson.name.startsWith('@types/')) {
                    // Special-case DefinitelyTyped
                    subdir = packageJson.name.substr(1)
                }
                const npmConfig = configuration['typescript.npmrc'] || {}
                const packageMeta = await fetchPackageMeta(packageJson.name, packageJson.version, npmConfig)

                // fileUri is usually a .d.ts file that does not exist in the repo, only in node_modules
                // Check if a source map exists to map it to the .ts source file that is checked into the repo
                let mappedUri: URL
                let mappedRange: Range
                try {
                    const sourceMapUri = new URL(fileUri.href + '.map')
                    const sourceMap = await pickResourceRetriever(sourceMapUri).fetch(sourceMapUri)
                    const consumer = await new SourceMapConsumer(sourceMap, sourceMapUri.href)
                    let mappedStart: NullableMappedPosition
                    let mappedEnd: NullableMappedPosition
                    try {
                        mappedStart = consumer.originalPositionFor({
                            line: location.range.start.line + 1,
                            column: location.range.start.character,
                        })
                        mappedEnd = consumer.originalPositionFor({
                            line: location.range.end.line + 1,
                            column: location.range.end.character,
                        })
                    } finally {
                        consumer.destroy()
                    }
                    if (
                        mappedStart.source === null ||
                        mappedStart.line === null ||
                        mappedStart.column === null ||
                        mappedEnd.line === null ||
                        mappedEnd.column === null
                    ) {
                        throw new Error('Could not map position')
                    }
                    mappedUri = new URL(mappedStart.source)
                    if (!mappedUri.href.startsWith(tempDirUri.href)) {
                        throw new Error(
                            `Mapped source URI ${mappedUri} is not under root URI ${fileRootUri} and not in automatic typings`
                        )
                    }
                    mappedRange = {
                        start: {
                            line: mappedStart.line - 1,
                            character: mappedStart.column,
                        },
                        end: {
                            line: mappedEnd.line - 1,
                            character: mappedEnd.column,
                        },
                    }
                } catch (err) {
                    throwIfCancelled(token)
                    if (err instanceof ResourceNotFoundError) {
                        logger.log(`No declaration map for ${fileUri}, using declaration file`)
                    } else {
                        logger.error(`Source-mapping location failed`, location, err)
                    }
                    // If mapping failed, use the original file
                    mappedUri = fileUri
                    mappedRange = location.range
                }

                const depRootDir = resolveDependencyRootDir(fileURLToPath(fileUri))
                const mappedPackageRelativeFilePath = path.posix.relative(depRootDir, fileURLToPath(mappedUri))
                const mappedRepoRelativeFilePath = path.posix.join(subdir, mappedPackageRelativeFilePath)

                // Use the Sourcegraph endpoint from configuration
                const instanceUrl = new URL(configuration['typescript.sourcegraphUrl'] || 'https://sourcegraph.com')
                const accessToken = configuration['typescript.accessToken']
                const repoName = await resolveRepository(cloneUrl, { instanceUrl, accessToken })
                const commit = packageMeta.gitHead
                if (!commit) {
                    logger.warn(`Package ${packageJson.name} has no gitHead metadata, using latest HEAD`)
                }
                const repoRev = [repoName, commit].filter(Boolean).join('@')
                const httpUrl = new URL(instanceUrl.href)
                httpUrl.pathname = path.posix.join(`/${repoRev}/-/raw/`, mappedRepoRelativeFilePath)
                if (accessToken) {
                    httpUrl.username = accessToken
                }
                return { uri: httpUrl.href, range: mappedRange }
            } catch (err) {
                throwIfCancelled(token)
                logger.error(`Could not resolve location in dependency to an HTTP URL`, location, err)
                // Return the file URI as an opaque identifier
                return location
            }
        }

        // Not in node_modules, do not map to external repo, don't apply source maps.
        const httpUri = mapFileToHttpUrlSimple(fileUri)
        return { uri: httpUri.href, range: location.range }
    }

    /**
     * Maps Locations returned as a result from a definition, type definition, implementation or references call to HTTP URLs
     * and potentially to external repositories if the location is in node_modules.
     *
     * @param definition One or multiple locations on the file system.
     */
    async function mapFileLocations(
        definition: Location | Location[] | null,
        { token }: { token: CancellationToken }
    ): Promise<Definition> {
        if (!definition) {
            return []
        }
        const arr = Array.isArray(definition) ? definition : [definition]
        return await Promise.all(arr.map(location => mapFileLocation(location, { token })))
    }

    async function openTextDocument(fileUri: URL): Promise<void> {
        if (openTextDocuments.has(fileUri)) {
            return
        }
        const didOpenParams: DidOpenTextDocumentParams = {
            textDocument: {
                uri: fileUri.href,
                version: 1,
                languageId: 'typescript',
                text: await pickResourceRetriever(fileUri).fetch(fileUri),
            },
        }
        languageServer.connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
        openTextDocuments.set(fileUri, didOpenParams)
    }

    /**
     * Forwards all requests of a certain method that returns Locations to the server, rewriting URIs.
     * It blocks on dependency installation if needed.
     * The returned locations get mapped to HTTP URLs and potentially to external repository URLs if they are in node_modules.
     */
    function forwardLocationRequests<P extends TextDocumentPositionParams>(
        type: RequestType<P, Location | Location[] | LocationLink[] | null>
    ): void {
        dispatcher.setRequestHandler(type, async (params, token, span) => {
            const mappedParams = await mapTextDocumentPositionParams(params, { span, token })
            const fileUri = new URL(mappedParams.textDocument.uri)
            // The TypeScript language server cannot service requests for documents that were not opened first
            await openTextDocument(fileUri)
            const result = await mapFileLocations(
                (await sendServerRequest(type, mappedParams, { tracer, span, token })) as Location | Location[] | null,
                { token }
            )
            return result
        })
    }

    forwardLocationRequests(DefinitionRequest.type)
    forwardLocationRequests(TypeDefinitionRequest.type)
    forwardLocationRequests(ReferencesRequest.type)
    forwardLocationRequests(ImplementationRequest.type)

    dispatcher.setRequestHandler(CodeActionRequest.type, async (params, token, span) => {
        const uri = new URL(params.textDocument.uri)
        const mappedParams: CodeActionParams = {
            ...params,
            textDocument: {
                uri: mapHttpToFileUrlSimple(uri).href,
            },
        }
        const fileUri = new URL(mappedParams.textDocument.uri)
        // The TypeScript language server cannot service requests for documents that were not opened first
        await openTextDocument(fileUri)
        const result = await sendServerRequest(CodeActionRequest.type, mappedParams, { tracer, span, token })
        return result
    })

    connectionDisposables.add(
        dispatcher.observeNotification(DidOpenTextDocumentNotification.type).subscribe(params => {
            try {
                const uri = new URL(params.textDocument.uri)
                const fileUri = mapHttpToFileUrlSimple(uri)
                const mappedParams: DidOpenTextDocumentParams = {
                    textDocument: {
                        ...params.textDocument,
                        uri: fileUri.href,
                    },
                }
                languageServer.connection.sendNotification(DidOpenTextDocumentNotification.type, mappedParams)
                openTextDocuments.set(fileUri, mappedParams)
            } catch (err) {
                logger.error('Error handling textDocument/didOpen notification', params, err)
            }
        })
    )
})

httpServer.listen(port, () => {
    globalLogger.log(`WebSocket server listening on port ${port}`)
})

const debugPort = Number(process.env.METRICS_PORT || 6060)
const debugServer = express()
const highlightCss = fs.readFileSync(require.resolve('highlight.js/styles/github.css'), 'utf-8')
/** Sends a plain text response, or highlighted HTML if `req.query.highlight` is set */
function sendText(req: express.Request, res: express.Response, language: string, code: string) {
    if (!req.query.highlight) {
        res.setHeader('Content-Type', prometheus.register.contentType)
        res.end(code)
    } else {
        res.setHeader('Content-Type', 'text/html')
        const highlighted = highlight(language, code, true).value
        res.end('<pre><code>\n' + highlighted + '</pre></code>\n' + '<style>\n' + highlightCss + '</style>\n')
    }
}
debugServer.get('/', (req, res) => {
    res.send(`
        <ul>
            <li><a href="/active_handles">Active handles</a></li>
            <li><a href="/metrics">Prometheus metrics</a></li>
        </ul>
    `)
})
// Prometheus metrics
debugServer.get('/metrics', (req, res) => {
    const metrics = prometheus.register.metrics()
    sendText(req, res, 'php', metrics)
})
// Endpoint to debug handle leaks (see also nodejs_active_handles_total Prometheus metric)
debugServer.get('/active_handles', (req, res) => {
    const handles = { ...process._getActiveHandles() } // spread to get indexes as keys
    const inspected = inspect(handles, req.query)
    sendText(req, res, 'javascript', inspected)
})

debugServer.listen(debugPort, () => {
    globalLogger.log(`Debug listening on http://localhost:${debugPort}`)
})
