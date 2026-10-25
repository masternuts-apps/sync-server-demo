import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isNodeError, SyncServerError } from '../errors.js';

export interface ResourceSnapshot {
  /** Stable client-visible identity used to address a synchronized resource. */
  resourceId: string;
  /** SHA-256 of the decoded manifest content. */
  digest: string;
  /** Manifest content encoded as canonical base64 for JSON transport/storage. */
  content: string;
  /** Immutable object digests that must already exist before this manifest is published. */
  objectDigests: string[];
}

export interface StoredResource extends ResourceSnapshot {
  /** Opaque concurrency token changed after each successful manifest write. */
  version: string;
}

export interface ResourceInfo {
  /** Stable client-visible identity used to address a synchronized resource. */
  resourceId: string;
  /** SHA-256 of the manifest content. */
  digest: string;
  /** Opaque token clients send back to conditionally update the resource. */
  version: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Return the lowercase SHA-256 hex digest for the supplied bytes. */
export function digestFor(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Narrow unknown input to a lowercase SHA-256 hex digest. */
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** Check that every object digest is valid and that no object is listed twice. */
function isObjectDigests(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((digest): digest is string => isSha256(digest))
    && new Set(value).size === value.length;
}

/** Decode canonical base64, rejecting malformed or non-canonical encodings. */
function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SyncServerError('invalid_data', 'Resource content must be valid base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new SyncServerError('invalid_data', 'Resource content must use canonical base64.');
  }
  return decoded;
}

/** Validate a resource identity before it is used to address stored data. */
function validateResourceId(resourceId: unknown): asserts resourceId is string {
  if (typeof resourceId !== 'string' || resourceId.trim().length === 0 || resourceId.length > 2048) {
    throw new SyncServerError('invalid_data', 'Resource ID must be a non-empty string of at most 2048 characters.');
  }
}

/** Validate a client snapshot and return its decoded manifest bytes. */
function validateSnapshot(snapshot: ResourceSnapshot): Buffer {
  validateResourceId(snapshot.resourceId);
  if (!isSha256(snapshot.digest) || !isObjectDigests(snapshot.objectDigests)) {
    throw new SyncServerError('invalid_data', 'Resource digest or object digest list is invalid.');
  }
  const content = decodeBase64(snapshot.content);
  if (digestFor(content) !== snapshot.digest) {
    throw new SyncServerError('invalid_data', 'Resource content does not match its digest.');
  }
  return content;
}

/** Parse and integrity-check a manifest envelope read from disk. */
function parseStoredResource(value: unknown): StoredResource {
  if (typeof value !== 'object' || value === null) {
    throw new SyncServerError('io', 'Stored resource envelope is malformed.');
  }
  const candidate = value as Partial<StoredResource>;
  if (typeof candidate.resourceId !== 'string'
    || typeof candidate.version !== 'string'
    || candidate.version.length === 0
    || typeof candidate.content !== 'string'
    || !isSha256(candidate.digest)
    || !isObjectDigests(candidate.objectDigests)) {
    throw new SyncServerError('io', 'Stored resource envelope is malformed.');
  }
  let content: Buffer;
  try {
    content = decodeBase64(candidate.content);
  } catch (error) {
    throw new SyncServerError(
      'io',
      `Stored resource has invalid base64 content: ${error instanceof Error ? error.message : 'invalid content'}`,
    );
  }
  if (digestFor(content) !== candidate.digest) {
    throw new SyncServerError('io', 'Stored resource failed digest validation.');
  }
  return candidate as StoredResource;
}

/**
 * Durable filesystem implementation of the SyncServer repository.
 *
 * Manifests are addressed by a hash of their resource ID; immutable objects
 * are addressed by their content digest. Manifest updates are serialized per
 * resource within this process and committed with an atomic rename.
 */
export class FileSystemSyncRepository {
  private readonly resourcesDirectory: string;
  private readonly objectsDirectory: string;
  private readonly resourceWrites = new Map<string, Promise<void>>();

  /** Configure the root directory; call initialize before relying on its folders. */
  constructor(private readonly dataDirectory: string) {
    this.resourcesDirectory = path.join(dataDirectory, 'resources');
    this.objectsDirectory = path.join(dataDirectory, 'objects');
  }

  /** Create the manifest and object directories if they do not exist. */
  async initialize(): Promise<void> {
    try {
      await Promise.all([
        mkdir(this.resourcesDirectory, { recursive: true }),
        mkdir(this.objectsDirectory, { recursive: true }),
      ]);
    } catch (error) {
      throw this.ioError('Cannot initialize sync storage.', error);
    }
  }

  /** Return the inventory of valid stored manifests. */
  async listResources(): Promise<ResourceInfo[]> {
    await this.initialize();
    let entries: string[];
    try {
      entries = await readdir(this.resourcesDirectory);
    } catch (error) {
      throw this.ioError('Cannot list stored resources.', error);
    }

    const resources: ResourceInfo[] = [];
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
      const resource = await this.readStoredResource(path.join(this.resourcesDirectory, entry));
      if (this.resourcePath(resource.resourceId) !== path.join(this.resourcesDirectory, entry)) {
        throw new SyncServerError('io', 'Stored resource filename does not match its resource ID.');
      }
      resources.push({
        resourceId: resource.resourceId,
        digest: resource.digest,
        version: resource.version,
      });
    }
    return resources;
  }

  /** Read and validate a manifest by its client-visible resource ID. */
  async readResource(resourceId: string): Promise<StoredResource> {
    validateResourceId(resourceId);
    await this.initialize();
    const resource = await this.readStoredResource(this.resourcePath(resourceId));
    if (resource.resourceId !== resourceId) {
      throw new SyncServerError('io', 'Stored resource ID does not match its storage key.');
    }
    return resource;
  }

  /** Check whether a valid object exists; a missing object is reported as false. */
  async hasObject(digest: string): Promise<boolean> {
    this.validateObjectDigest(digest);
    await this.initialize();
    try {
      const content = await readFile(this.objectPath(digest));
      if (digestFor(content) !== digest) {
        throw new SyncServerError('io', 'Stored object failed digest validation.');
      }
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false;
      }
      if (error instanceof SyncServerError) {
        throw error;
      }
      throw this.ioError('Cannot inspect stored object.', error);
    }
  }

  /** Read an object and verify its bytes still match the requested digest. */
  async readObject(digest: string): Promise<Buffer> {
    this.validateObjectDigest(digest);
    await this.initialize();
    let content: Buffer;
    try {
      content = await readFile(this.objectPath(digest));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new SyncServerError('not_found', 'Sync object does not exist.');
      }
      throw this.ioError('Cannot read sync object.', error);
    }
    if (digestFor(content) !== digest) {
      throw new SyncServerError('io', 'Stored object failed digest validation.');
    }
    return content;
  }

  /** Store an immutable object once, verifying that its bytes match its digest. */
  async writeObject(digest: string, content: Buffer): Promise<void> {
    this.validateObjectDigest(digest);
    if (digestFor(content) !== digest) {
      throw new SyncServerError('invalid_data', 'Object content does not match its digest.');
    }
    await this.initialize();
    if (await this.hasObject(digest)) {
      return;
    }
    await this.atomicWrite(this.objectPath(digest), content);
  }

  /**
   * Publish a manifest after its referenced objects exist.
   *
   * A null expected version means create-only; otherwise the write succeeds
   * only when the current opaque version matches the supplied token.
   */
  async writeResource(
    snapshot: ResourceSnapshot,
    expectedVersion: string | null,
  ): Promise<string> {
    const content = validateSnapshot(snapshot);
    await this.initialize();
    for (const digest of snapshot.objectDigests) {
      if (!await this.hasObject(digest)) {
        throw new SyncServerError('invalid_data', 'Resource references an unavailable sync object.');
      }
    }

    return this.withResourceLock(snapshot.resourceId, async () => {
      const resourcePath = this.resourcePath(snapshot.resourceId);
      const current = await this.readOptionalResource(resourcePath);
      if (expectedVersion === null) {
        if (current) {
          throw new SyncServerError('version_conflict', 'Resource already exists on the server.');
        }
      } else if (!current || current.version !== expectedVersion) {
        throw new SyncServerError('version_conflict', 'Server resource version changed before write.');
      }

      const version = randomUUID();
      const resource: StoredResource = {
        ...snapshot,
        content: content.toString('base64'),
        version,
      };
      await this.atomicWrite(resourcePath, Buffer.from(JSON.stringify(resource)));
      return version;
    });
  }

  /** Read a manifest when present, mapping only the not-found case to null. */
  private async readOptionalResource(resourcePath: string): Promise<StoredResource | null> {
    try {
      return await this.readStoredResource(resourcePath);
    } catch (error) {
      if (error instanceof SyncServerError && error.code === 'not_found') {
        return null;
      }
      throw error;
    }
  }

  /** Read a manifest file and reject missing, malformed, or corrupt data. */
  private async readStoredResource(resourcePath: string): Promise<StoredResource> {
    let bytes: Buffer;
    try {
      bytes = await readFile(resourcePath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new SyncServerError('not_found', 'Sync resource does not exist.');
      }
      throw this.ioError('Cannot read stored resource.', error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new SyncServerError(
        'io',
        `Stored resource contains invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`,
      );
    }
    return parseStoredResource(parsed);
  }

  /**
   * Persist bytes through a unique temporary file, flush, then rename.
   * The rename prevents readers from observing a partially-written file.
   */
  private async atomicWrite(filePath: string, content: Buffer): Promise<void> {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporaryPath, 'wx');
      await file.writeFile(content);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, filePath);
      if (process.platform !== 'win32') {
        const directory = await open(path.dirname(filePath), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      if (file) {
        await file.close();
      }
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
          throw this.ioError('Cannot clean up an incomplete sync write.', cleanupError);
        }
      }
      throw this.ioError('Cannot persist sync data.', error);
    }
  }

  /** Serialize writes to one resource while allowing unrelated resources to proceed. */
  private async withResourceLock<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resourceWrites.get(resourceId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.resourceWrites.set(resourceId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.resourceWrites.get(resourceId) === current) {
        this.resourceWrites.delete(resourceId);
      }
    }
  }

  /** Derive a filesystem-safe manifest path from a resource ID. */
  private resourcePath(resourceId: string): string {
    const key = createHash('sha256').update(resourceId, 'utf8').digest('hex');
    return path.join(this.resourcesDirectory, `${key}.json`);
  }

  /** Derive an object path from its lowercase SHA-256 digest. */
  private objectPath(digest: string): string {
    return path.join(this.objectsDirectory, `${digest}.obj`);
  }

  /** Reject object keys that cannot be valid lowercase SHA-256 digests. */
  private validateObjectDigest(digest: string): void {
    if (!isSha256(digest)) {
      throw new SyncServerError('invalid_data', 'Object digest must be a lowercase SHA-256 value.');
    }
  }

  /** Convert a filesystem failure into the repository's stable error type. */
  private ioError(message: string, error: unknown): SyncServerError {
    const detail = error instanceof Error ? error.message : 'unknown filesystem error';
    return new SyncServerError('io', `${message} ${detail}`);
  }
}
