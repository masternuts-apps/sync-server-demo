import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { SyncServerError } from './errors.js';
import {
    FileSystemSyncRepository,
    type ResourceSnapshot,
} from './storage/FileSystemSyncRepository.js';

interface AppOptions {
    dataDirectory: string;
    maxManifestBytes?: string;
    maxObjectBytes?: string;
}

/** Check whether an untrusted JSON value has the fields required for a snapshot. */
function isResourceSnapshot(value: unknown): value is ResourceSnapshot {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<ResourceSnapshot>;
    return typeof candidate.resourceId === 'string'
        && typeof candidate.digest === 'string'
        && typeof candidate.content === 'string'
        && Array.isArray(candidate.objectDigests)
        && candidate.objectDigests.every((digest) => typeof digest === 'string');
}

/** Resolve the required conditional-write headers to a create or update version. */
function parseExpectedVersion(
    ifMatch: string | undefined,
    ifNoneMatch: string | undefined,
): string | null {
    if (ifMatch !== undefined && ifNoneMatch !== undefined) {
        throw new SyncServerError('invalid_data', 'Use only one conditional write header.');
    }
    if (ifNoneMatch === '*') {
        return null;
    }
    if (ifNoneMatch !== undefined) {
        throw new SyncServerError('invalid_data', 'If-None-Match must be * for a create-only write.');
    }
    if (ifMatch === undefined) {
        throw new SyncServerError('invalid_data', 'A conditional write header is required.');
    }
    const match = /^"([^"]+)"$/.exec(ifMatch);
    if (!match?.[1]) {
        throw new SyncServerError('invalid_data', 'If-Match must contain one quoted version token.');
    }
    return match[1];
}

/** Format a resource version as an HTTP entity tag. */
function quoteEtag(version: string): string {
    return `"${version}"`;
}

/** Identify Express body-parser errors caused by a request exceeding its size limit. */
function isPayloadTooLarge(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'type' in error
        && error.type === 'entity.too.large';
}

/** Build the Express API and connect its routes to the filesystem repository. */
export function createApp(options: AppOptions): express.Express {
    const app = express();
    const repository = new FileSystemSyncRepository(path.resolve(options.dataDirectory));

    app.disable('x-powered-by');

    // Log each completed API call using its route template, never resource IDs or query data.
    app.use((request, response, next) => {
        const startedAt = Date.now();
        response.once('finish', () => {
            console.info('SyncServer API request completed', {
                method: request.method,
                route: request.route?.path ?? 'unmatched',
                statusCode: response.statusCode,
                durationMs: Date.now() - startedAt,
            });
        });
        next();
    });
    app.use(express.json({ limit: options.maxManifestBytes ?? '16mb', strict: true }));

    /** Return a simple liveness response without touching the storage layer. */
    app.get('/health', (_request, response) => {
        response.status(200).json({ status: 'ok' });
    });

    /** List the identifiers, digests, and versions of stored manifests. */
    app.get('/v1/resources', async (_request, response) => {
        response.status(200).json(await repository.listResources());
    });

    /** Read one manifest and return its current version as an ETag. */
    app.get('/v1/resources/:resourceId', async (request, response) => {
        const resource = await repository.readResource(request.params.resourceId);
        response.set('ETag', quoteEtag(resource.version));
        response.status(200).json(resource);
    });

    /** Create or conditionally update a manifest using its ETag version token. */
    app.put('/v1/resources/:resourceId', async (request, response) => {
        if (!isResourceSnapshot(request.body)) {
            throw new SyncServerError('invalid_data', 'Request body is not a resource snapshot.');
        }
        if (request.params.resourceId !== request.body.resourceId) {
            throw new SyncServerError('invalid_data', 'Resource ID in the URL and body must match.');
        }
        const expectedVersion = parseExpectedVersion(
            request.get('If-Match'),
            request.get('If-None-Match'),
        );
        const version = await repository.writeResource(request.body, expectedVersion);
        response.set('ETag', quoteEtag(version));
        response.status(200).json({ version });
    });

    /** Check whether an immutable object with the requested digest is stored. */
    app.head('/v1/objects/:digest', async (request, response) => {
        if (!await repository.hasObject(request.params.digest)) {
            response.status(404).end();
            return;
        }
        response.status(200).end();
    });

    /** Read and return an immutable object after verifying its content digest. */
    app.get('/v1/objects/:digest', async (request, response) => {
        const content = await repository.readObject(request.params.digest);
        response.type('application/octet-stream').status(200).send(content);
    });

    /** Store raw object bytes after validating the content type and digest. */
    app.put(
        '/v1/objects/:digest',
        express.raw({ type: 'application/octet-stream', limit: options.maxObjectBytes ?? '64mb' }),
        async (request, response) => {
            if (!Buffer.isBuffer(request.body)) {
                throw new SyncServerError('invalid_data', 'Object body must use application/octet-stream.');
            }
            await repository.writeObject(request.params.digest, request.body);
            response.status(204).end();
        },
    );

    /** Return the standard API error response for an unknown route. */
    app.use((_request, response) => {
        response.status(404).json({
            error: { code: 'not_found', message: 'SyncServer endpoint does not exist.' },
        });
    });

    /** Translate application and request-parsing failures into stable HTTP errors. */
    const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
        if (error instanceof SyncServerError) {
            const status = error.code === 'not_found'
                ? 404
                : error.code === 'version_conflict'
                    ? 409
                    : error.code === 'invalid_data'
                        ? 400
                        : 500;
            response.status(status).json({ error: { code: error.code, message: error.message } });
            return;
        }
        if (isPayloadTooLarge(error)) {
            response.status(413).json({
                error: { code: 'payload_too_large', message: 'Request body exceeds the configured limit.' },
            });
            return;
        }
        if (error instanceof SyntaxError) {
            response.status(400).json({
                error: { code: 'invalid_data', message: 'Request body contains invalid JSON.' },
            });
            return;
        }
        console.error('Unhandled SyncServer request failure:', error);
        response.status(500).json({
            error: { code: 'internal', message: 'The server could not complete the request.' },
        });
    };
    app.use(errorHandler);
    return app;
}
