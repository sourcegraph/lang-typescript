import 'source-map-support/register'

// Polyfill
import { AbortController } from 'abort-controller'
Object.assign(global, { AbortController })

import {
    createMessageConnection,
    IWebSocket,
    MessageConnection,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import * as rpcServer from '@sourcegraph/vscode-ws-jsonrpc/lib/server'
import { fork } from 'child_process'
import * as http from 'http'
import * as https from 'https'
import { Tracer as LightstepTracer } from 'lightstep-tracer'
import { cloneDeep, noop } from 'lodash'
import mkdirp from 'mkdirp-promise'
import { realpathSync } from 'mz/fs'
import * as fs from 'mz/fs'
import { FORMAT_HTTP_HEADERS, Span, Tracer } from 'opentracing'
import { tmpdir } from 'os'
import fetchPackageMeta from 'package-json'
import * as path from 'path'
import * as prometheus from 'prom-client'
import request from 'request'
import rmfr from 'rmfr'
import { NullableMappedPosition, SourceMapConsumer } from 'source-map'
import { Tail } from 'tail'
import { extract, FileStat } from 'tar'
import { fileURLToPath, pathToFileURL } from 'url'
import uuid = require('uuid')
import {
    CancellationToken,
    Definition,
    DefinitionRequest,
    DidOpenTextDocumentNotification,
    HoverRequest,
    ImplementationRequest,
    InitializeRequest,
    IPCMessageReader,
    IPCMessageWriter,
    Location,
    LogMessageNotification,
    Range,
    ReferencesRequest,
    TextDocumentPositionParams,
    TypeDefinitionRequest,
} from 'vscode-languageserver-protocol'
import { Server } from 'ws'
import { createAbortError, throwIfCancelled } from './cancellation'
import { filterDependencies, getClosestPackageJson, PackageJson, resolveDependencyRootDir } from './dependencies'
import { createDispatcher, createRequestDurationMetric, NotificationType, RequestType } from './dispatcher'
import { AsyncDisposable, Disposable, disposeAll, disposeAllAsync, subscriptionToDisposable } from './disposable'
import { resolveRepository } from './graphql'
import { LOG_LEVEL_TO_LSP, Logger, LSP_TO_LOG_LEVEL, LSPLogger, MultiLogger, PrefixedLogger } from './logging'
import { tracePromise } from './tracing'
import { sanitizeTsConfigs } from './tsconfig'
import { relativeUrl } from './uri'
import { install } from './yarn'

const CACHE_DIR = process.env.CACHE_DIR || realpathSync(tmpdir())
console.log(`Using CACHE_DIR ${CACHE_DIR}`)

/**
 * Rewrites all `uri` properties in an object, recursively
 */
function rewriteUris(obj: any, transform: (uri: URL) => URL): void {
    // Scalar
    if (typeof obj !== 'object' || obj === null) {
        return
    }
    // Array
    if (Array.isArray(obj)) {
        for (const element of obj) {
            rewriteUris(element, transform)
        }
        return
    }
    // Object
    if ('uri' in obj) {
        obj.uri = transform(new URL(obj.uri)).href
    }
    for (const key of Object.keys(obj)) {
        rewriteUris(obj[key], transform)
    }
}

let tracer = new Tracer()
if (process.env.LIGHTSTEP_ACCESS_TOKEN) {
    console.log('LightStep tracing enabled')
    tracer = new LightstepTracer({
        access_token: process.env.LIGHTSTEP_ACCESS_TOKEN,
        component_name: 'lang-typescript',
    })
}

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080

let httpServer: http.Server | https.Server
if (process.env.TLS_CERT && process.env.TLS_KEY) {
    console.log('TLS encryption enabled')
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
        console.log(`Received ${signal}, cleaning up`)
        await disposeAllAsync(globalDisposables)
        process.exit(0)
    })
}

const webSocketServer = new Server({ server: httpServer })

const openConnectionsMetric = new prometheus.Gauge({
    name: 'typescript_open_websocket_connections',
    help: 'Open WebSocket connections to the TypeScript server',
})
const requestDurationMetric = createRequestDurationMetric()
prometheus.collectDefaultMetrics()
let openConnections = 0

interface Configuration {
    'typescript.langserver.log'?: false | 'log' | 'info' | 'warn' | 'error'
    'typescript.tsserver.log'?: false | 'terse' | 'normal' | 'requestTime' | 'verbose'
    'typescript.accessToken'?: string
    'sourcegraph.url'?: string
}

// Send a ping frame every 10s to keep the browser connection alive
setInterval(() => {
    for (const client of webSocketServer.clients) {
        client.ping()
    }
}, 10000)

const isTypeScriptFile = (path: string): boolean => /((\.d)?\.[tj]sx?|json)$/.test(path)

webSocketServer.on('connection', connection => {
    const connectionId = uuid.v1()
    openConnectionsMetric.inc()
    openConnections++
    console.log(`New WebSocket connection, ${openConnections} open`)

    /** Functions to run when this connection is closed (or the server shuts down) */
    const connectionDisposables = new Set<AsyncDisposable | Disposable>()
    {
        const connectionDisposable: AsyncDisposable = {
            disposeAsync: async () => await disposeAllAsync([...connectionDisposables].reverse()),
        }
        globalDisposables.add(connectionDisposable)
        connectionDisposables.add({ dispose: () => globalDisposables.delete(connectionDisposable) })
        const closeListener = async (code: number, reason: string) => {
            openConnections--
            openConnectionsMetric.dec()
            console.log(`WebSocket closed, ${openConnections} open`, { code, reason })
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
        console
    )
    const logger: Logger = new MultiLogger([
        new PrefixedLogger(console, `conn ${connectionId}`),
        new LSPLogger(webSocketMessageConnection),
    ])
    const connectionLogger = logger
    logger.log(`Connection ID ${connectionId}`)

    // Connection state set on initialize
    let serverMessageConnection: MessageConnection
    let configuration: Configuration = {}
    let tempDir: string
    let httpRootUri: URL
    let fileRootUri: URL
    let extractPath: string
    // yarn folders
    let globalFolderRoot: string
    let cacheFolderRoot: string
    /** HTTP URIs for directories in the workspace that contain a package.json */
    let packageRootUris: Set<string>
    /** Map from HTTP URI for directory of package.json to Promise for its installation */
    const dependencyInstallationPromises = new Map<string, Promise<void>>()
    /** HTTP URIs of directories with package.jsons in the workspace that finished installation */
    const finishedDependencyInstallations = new Set<string>()

    const dispatcher = createDispatcher(webSocketConnection, { tracer, logger, requestDurationMetric })
    connectionDisposables.add({ dispose: () => dispatcher.dispose() })

    /**
     * @param httpUri Example: `https://accesstoken@sourcegraph.com/github.com/sourcegraph/extensions-client-common@80389224bd48e1e696d5fa11b3ec6fba341c695b/-/raw/src/schema/graphqlschema.ts`
     */
    const transformHttpToFileUri = (httpUri: URL): URL => {
        const relative = relativeUrl(httpRootUri, httpUri)
        const fileUri = new URL(relative, fileRootUri.href)
        // Security check to prevent access from one connection into
        // other files on the container or other connection's directories
        if (!fileUri.href.startsWith(fileRootUri.href)) {
            throw new Error(`URI ${httpUri} is not under rootUri ${httpRootUri}`)
        }
        return fileUri
    }

    dispatcher.setRequestHandler(InitializeRequest.type, async (params, token, span) => {
        if (!params.rootUri) {
            throw new Error('No rootUri given as initialize parameter')
        }
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

        // Create temp folders
        tempDir = path.join(CACHE_DIR, connectionId)
        await mkdirp(tempDir)
        connectionDisposables.add({
            disposeAsync: async () => {
                console.log('Deleting temp dir ', tempDir)
                await rmfr(tempDir)
            },
        })
        extractPath = path.join(tempDir, 'repo')
        cacheFolderRoot = path.join(tempDir, 'cache')
        globalFolderRoot = path.join(tempDir, 'global')
        await Promise.all([fs.mkdir(extractPath), fs.mkdir(cacheFolderRoot), fs.mkdir(globalFolderRoot)])

        const serverArgs: string[] = [
            '--node-ipc',
            // Use local tsserver instead of the tsserver of the repo for security reasons
            '--tsserver-path=' + path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsserver'),
        ]
        if (configuration['typescript.langserver.log']) {
            serverArgs.push('--log-level=' + LOG_LEVEL_TO_LSP[configuration['typescript.langserver.log'] || 'log'])
        }
        if (configuration['typescript.tsserver.log']) {
            // Prepare tsserver log file
            const tsserverLogFile = path.resolve(tempDir, 'tsserver.log')
            await fs.writeFile(tsserverLogFile, '') // File needs to exist or else Tail will error
            const tsserverLogger = new PrefixedLogger(logger, 'tsserver')
            // Set up a tail -f on the tsserver logfile and forward the logs to the logger
            const tsserverTail = new Tail(tsserverLogFile, { follow: true, fromBeginning: true })
            connectionDisposables.add({ dispose: () => tsserverTail.unwatch() })
            tsserverTail.on('line', line => tsserverLogger.log(line + ''))
            tsserverTail.on('error', err => logger.error('Error tailing tsserver logs', err))
            serverArgs.push('--tsserver-log-file', tsserverLogFile)
            serverArgs.push('--tsserver-log-verbosity', configuration['typescript.tsserver.log'] || 'verbose')
        }
        // Spawn language server
        const serverProcess = fork(
            path.resolve(__dirname, '..', '..', 'node_modules', 'typescript-language-server', 'lib', 'cli.js'),
            serverArgs,
            { stdio: ['ipc', 'inherit'] }
        )
        connectionDisposables.add({ dispose: () => serverProcess.kill() })
        serverProcess.on('error', err => {
            logger.error('Launching language server failed', err)
            connection.close()
        })
        // Log language server STDERR output
        const languageServerLogger = new PrefixedLogger(logger, 'langserver')
        serverProcess.stderr.on('data', chunk => languageServerLogger.log(chunk + ''))
        const languageServerReader = new IPCMessageReader(serverProcess)
        const languageServerWriter = new IPCMessageWriter(serverProcess)
        connectionDisposables.add(languageServerWriter)
        serverMessageConnection = createMessageConnection(languageServerReader, languageServerWriter, logger)
        connectionDisposables.add(serverMessageConnection)
        serverMessageConnection.listen()

        // Forward log messages from the language server to the browser
        {
            const languageServerDispatcher = createDispatcher(
                { reader: languageServerReader, writer: languageServerWriter },
                { tracer, logger }
            )
            const languageServerLogger = new PrefixedLogger(logger, 'langserver')
            connectionDisposables.add(
                subscriptionToDisposable(
                    languageServerDispatcher.observeNotification(LogMessageNotification.type).subscribe(params => {
                        const type = LSP_TO_LOG_LEVEL[params.type]
                        languageServerLogger[type](params.message)
                    })
                )
            )
        }

        // Fetch tar and extract into temp folder
        const packageJsonPaths: string[] = []
        logger.info('Fetching archive from', httpRootUri.href)
        logger.log('Extracting to', extractPath)
        await tracePromise('Fetch source archive', tracer, span, async span => {
            const using: Disposable[] = []
            try {
                span.setTag('url', httpRootUri.href)
                let bytes = 0
                await new Promise<void>((resolve, reject) => {
                    const headers = {
                        Accept: 'application/x-tar',
                        'User-Agent': 'TypeScript language server',
                    }
                    span.tracer().inject(span, FORMAT_HTTP_HEADERS, headers)
                    const archiveRequest = request(httpRootUri.href, { headers })
                    using.push(
                        token.onCancellationRequested(() => {
                            archiveRequest.abort()
                            reject(createAbortError())
                        })
                    )
                    archiveRequest
                        .once('error', reject)
                        .once('response', ({ statusCode, statusMessage }) => {
                            if (statusCode >= 400) {
                                archiveRequest.abort()
                                reject(
                                    new Error(
                                        `Archive fetch of ${httpRootUri} failed with ${statusCode} ${statusMessage}`
                                    )
                                )
                            }
                        })
                        .on('data', (chunk: Buffer) => {
                            bytes += chunk.byteLength
                        })
                        .pipe(extract({ cwd: extractPath, filter: isTypeScriptFile }))
                        .on('entry', (entry: FileStat) => {
                            if (entry.header.path && entry.header.path.endsWith('package.json')) {
                                packageJsonPaths.push(entry.header.path)
                            }
                        })
                        .on('warn', warning => logger.warn(warning))
                        .once('finish', resolve)
                        .once('error', reject)
                })
                span.setTag('bytes', bytes)
            } finally {
                disposeAll(using, logger)
            }
        })

        // Find package.jsons to install
        throwIfCancelled(token)
        logger.log('package.jsons found:', packageJsonPaths)
        packageRootUris = new Set(
            packageJsonPaths.map(packageJsonPath => new URL(path.dirname(packageJsonPath) + '/', httpRootUri.href).href)
        )

        // Sanitize tsconfig.json files
        await sanitizeTsConfigs({ cwd: extractPath, logger, tracer, span, token })

        // The trailing slash is important for resolving URL relatively to it
        fileRootUri = pathToFileURL(extractPath + '/')
        // URIs are rewritten by rewriteUris below, but it doesn't touch rootPath
        params = { ...params, rootPath: extractPath }

        return await callServer(InitializeRequest.type, params, token)
    })

    /** Sends a request to the server, rewriting URIs in the parameters and result. */
    async function callServer<P, R>(type: RequestType<P, R>, params: P, token: CancellationToken): Promise<R> {
        throwIfCancelled(token)
        params = cloneDeep(params)
        rewriteUris(params, transformHttpToFileUri)
        const result = await serverMessageConnection.sendRequest(type, params, token)
        return result
    }

    /**
     * Returns all known package.json directories that are an ancestor of the given URI (and therefor should be installed to provide codeintel on this URI).
     *
     * @param uri The HTTP URL of a text document
     * @return HTTP URLs of package.json directories
     */
    const findParentPackageRoots = (uri: URL): URL[] =>
        [...packageRootUris]
            .filter(packageRoot => uri.href.startsWith(packageRoot))
            .map(packageRoot => new URL(packageRoot))

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
                const hasDeps = await filterDependencies(absPackageJsonPath, { logger, tracer, span, token })
                if (!hasDeps) {
                    return
                }
                // It's important that each concurrent yarn process has their own global and cache folders
                const globalFolder = path.join(globalFolderRoot, relPackageRoot)
                const cacheFolder = path.join(cacheFolderRoot, relPackageRoot)
                const cwd = path.join(extractPath, relPackageRoot)
                await Promise.all([mkdirp(path.join(globalFolder)), mkdirp(path.join(cacheFolder))])
                await install({ cwd, globalFolder, cacheFolder, logger, tracer, span, token })
                await sanitizeTsConfigs({
                    cwd: path.join(cwd, 'node_modules'),
                    logger,
                    tracer,
                    span,
                    token,
                })
            } catch (err) {
                logger.error('Installation failed', err)
            } finally {
                finishedDependencyInstallations.add(packageRootUri.href)
            }
        })
    }

    /**
     * Ensures dependencies for all package.jsons in parent directories of the given text document were installed.
     * Errors will be caught and logged.
     *
     * @param textDocumentUri The HTTP text document URI that dependencies should be installed for
     * @throws never
     */
    async function ensureDependencies(
        textDocumentUri: URL,
        { tracer, span, token = CancellationToken.None }: { tracer: Tracer; span?: Span; token?: CancellationToken }
    ): Promise<void> {
        await tracePromise('Ensure dependencies', tracer, span, async span => {
            throwIfCancelled(token)
            const parentPackageRoots = findParentPackageRoots(textDocumentUri)
            span.setTag('packageJsonLocations', parentPackageRoots.map(String))
            logger.log(
                `Ensuring dependencies for text document ${textDocumentUri} defined in`,
                parentPackageRoots.map(String)
            )
            await Promise.all(
                parentPackageRoots.map(async packageRootUri => {
                    let installationPromise = dependencyInstallationPromises.get(packageRootUri.href)
                    if (!installationPromise) {
                        installationPromise = installDependenciesForPackage(packageRootUri, { tracer, span, token })
                        // Save Promise so requests can wait for the installation to finish
                        dependencyInstallationPromises.set(packageRootUri.href, installationPromise)
                    }
                    await installationPromise
                })
            )
        })
    }

    dispatcher.setRequestHandler(HoverRequest.type, async (params, token, span) => {
        const textDocumentUri = new URL(params.textDocument.uri)
        const hover = await callServer(HoverRequest.type, params, token)
        const contents = !hover ? [] : Array.isArray(hover.contents) ? hover.contents : [hover.contents]
        const contentStrings = contents.map(c => (typeof c === 'string' ? c : c.value)).filter(s => !!s.trim())
        // Check if the type is `any` or the import is shown as the declaration
        if (contentStrings.length === 0 || contentStrings.some(s => /\b(any|import)\b/.test(s))) {
            await ensureDependencies(textDocumentUri, { tracer, span, token })
            return await callServer(HoverRequest.type, params, token)
        }
        // If any of the parent package.json roots is not finished installing, let the user know
        if (findParentPackageRoots(textDocumentUri).some(root => !finishedDependencyInstallations.has(root.href))) {
            contents.push(
                '_Dependency installation is still in progress. The information shown might be missing type information._'
            )
        }
        return { ...hover, contents }
    })

    /**
     * Maps Locations returned as a result from a definition, type definition, implementation or references call to HTTP URLs
     * and potentially to external repositories if the location is in node_modules.
     *
     * @param location A location on the file system (with a `file:` URI)
     */
    async function mapFileLocation(location: Location): Promise<Location> {
        const uri = new URL(location.uri)
        const relativeFilePath = decodeURIComponent(relativeUrl(fileRootUri, uri))
        // Check if file path is inside a node_modules dir
        // If it is inside node_modules, that means the file is out-of-workspace, i.e. outside of the HTTP root URI
        // We return an HTTP URL to the client that the client can access
        if (relativeFilePath.includes('node_modules/')) {
            try {
                const packageJson = await getClosestPackageJson(uri, fileRootUri)
                if (!packageJson.repository) {
                    throw new Error(`Package ${packageJson.name} has no repository field`)
                }
                const cloneUrl =
                    typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository.url
                const packageMeta = (await fetchPackageMeta(packageJson.name, {
                    version: packageJson.version,
                    fullMetadata: true,
                })) as PackageJson
                const commit = packageMeta.gitHead
                if (!commit) {
                    throw new Error(`Package ${packageJson.name} has no gitHead metadata`)
                }
                const subdir = (typeof packageJson.repository === 'object' && packageJson.repository.directory) || ''

                // fileUri is usually a .d.ts file that does not exist in the repo, only in node_modules
                // Check if a source map exists to map it to the .ts source file that is checked into the repo
                let mappedUri: URL
                let mappedRange: Range
                try {
                    const sourceMapUri = new URL(uri.href + '.map')
                    const sourceMap = await fs.readFile(fileURLToPath(sourceMapUri), 'utf-8')
                    const consumer = await new SourceMapConsumer(sourceMap, sourceMapUri.href)
                    let mappedStart: NullableMappedPosition
                    let mappedEnd: NullableMappedPosition
                    try {
                        mappedStart = consumer.originalPositionFor({
                            line: location.range.start.line,
                            column: location.range.start.character,
                        })
                        mappedEnd = consumer.originalPositionFor({
                            line: location.range.end.line,
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
                    if (!mappedUri.href.startsWith(fileRootUri.href)) {
                        throw new Error(`Mapped source URI ${mappedUri} is not under root URI ${fileRootUri}`)
                    }
                    mappedRange = {
                        start: {
                            line: mappedStart.line,
                            character: mappedStart.column,
                        },
                        end: {
                            line: mappedEnd.line,
                            character: mappedEnd.column,
                        },
                    }
                } catch (err) {
                    logger.error(`Source-mapping location failed`, location, err)
                    // If mapping failed, use the original file
                    mappedUri = uri
                    mappedRange = location.range
                }

                const depRootDir = resolveDependencyRootDir(relativeFilePath)
                const mappedRelativeFilePath = decodeURIComponent(relativeUrl(fileRootUri, mappedUri))
                const mappedPackageRelativeFilePath = path.posix.relative(depRootDir, mappedRelativeFilePath)
                const mappedRepoRelativeFilePath = path.posix.join(subdir, mappedPackageRelativeFilePath)

                // Use the Sourcegraph endpoint from configuration
                const instanceUrl = new URL(configuration['sourcegraph.url'] || 'https://sourcegraph.com')
                const accessToken = configuration['typescript.accessToken']
                const repoName = await resolveRepository(cloneUrl, { instanceUrl, accessToken })
                const httpUrl = new URL(instanceUrl.href)
                httpUrl.pathname = path.posix.join(`/${repoName}@${commit}/-/raw/`, mappedRepoRelativeFilePath)
                if (accessToken) {
                    httpUrl.username = accessToken
                }
                return { uri: httpUrl.href, range: mappedRange }
            } catch (err) {
                logger.error(`Could not resolve location in dependency to an HTTP URL`, location, err)
                // Return the file URI as an opaque identifier
                return location
            }
        }

        // Not in node_modules, do not map to external repo, don't apply source maps.
        const httpUri = new URL(relativeFilePath, httpRootUri.href)
        if (!httpUri.href.startsWith(httpRootUri.href)) {
            // Should never happen, since these are outgoing URIs
            // Sanity check against bugs (e.g. not realpath()ing the temp dir)
            throw new Error(`URI ${httpUri} is not under rootUri ${httpRootUri}`)
        }
        return { uri: httpUri.href, range: location.range }
    }

    /**
     * Maps Locations returned as a result from a definition, type definition, implementation or references call to HTTP URLs
     * and potentially to external repositories if the location is in node_modules.
     *
     * @param definition One or multiple locations on the file system.
     */
    async function mapFileLocations(definition: Definition): Promise<Definition> {
        if (!definition) {
            return []
        }
        const arr = Array.isArray(definition) ? definition : [definition]
        return await Promise.all(arr.map(mapFileLocation))
    }

    /** Checks if a location result is not satisfactory and should be retried after dependency installation finished */
    function shouldLocationsWaitForDependencies(params: TextDocumentPositionParams, locations: Definition): boolean {
        if (!locations) {
            return true
        }
        const locationsArray = Array.isArray(locations) ? locations : [locations]
        if (locationsArray.length === 0) {
            return true
        }
        // Check if the only definition/reference found is the line that was requested
        if (
            locationsArray.length === 1 &&
            locationsArray[0].uri === params.textDocument.uri &&
            locationsArray[0].range.start.line === params.position.line
        ) {
            return true
        }
        // TODO check if location is at import statement
        return false
    }

    /**
     * Forwards all requests of a certain method that returns Locations to the server, rewriting URIs.
     * It blocks on dependency installation if needed.
     * The returned locations get mapped to HTTP URLs and potentially to external repository URLs if they are in node_modules.
     */
    function forwardLocationRequests<P extends TextDocumentPositionParams>(type: RequestType<P, Definition>): void {
        dispatcher.setRequestHandler(type, async (params, token, span) => {
            const result = await mapFileLocations(await callServer(type, params, token))
            if (shouldLocationsWaitForDependencies(params, result)) {
                await ensureDependencies(new URL(params.textDocument.uri), { tracer, span, token })
                return await mapFileLocations(await callServer(type, params, token))
            }
            return result
        })
    }

    forwardLocationRequests(DefinitionRequest.type)
    forwardLocationRequests(TypeDefinitionRequest.type)
    forwardLocationRequests(ReferencesRequest.type)
    forwardLocationRequests(ImplementationRequest.type)

    /** Sends a notification to the server, rewriting URIs in the parameters and result. */
    function notifyServer<P, R>(type: NotificationType<P>, params: P): void {
        params = cloneDeep(params)
        rewriteUris(params, transformHttpToFileUri)
        serverMessageConnection.sendNotification(type, params)
    }

    connectionDisposables.add(
        subscriptionToDisposable(
            dispatcher.observeNotification(DidOpenTextDocumentNotification.type).subscribe(params => {
                notifyServer(DidOpenTextDocumentNotification.type, params)
                // Kick off installation in the background
                // tslint:disable-next-line no-floating-promises
                ensureDependencies(new URL(params.textDocument.uri), { tracer })
            })
        )
    )
})

httpServer.listen(port, () => {
    console.log(`WebSocket server listening on port ${port}`)
})

// Prometheus metrics
const metricsPort = process.env.METRICS_PORT || 6060
const metricsServer = http.createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(prometheus.register.metrics())
})
metricsServer.on('error', err => console.error('Metrics server error', err)) // don't crash on metrics
metricsServer.listen(metricsPort, () => {
    console.log(`Prometheus metrics on http://localhost:${metricsPort}`)
})
