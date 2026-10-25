import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function withServer<T>(
  dataDirectory: string,
  action: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(createApp({ dataDirectory }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  const closed = once(server, 'close');
  server.close();
  await closed;
}

test('persists manifests and immutable objects across server restart', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'qsuite-sync-server-'));
  const object = Buffer.from('image-payload');
  const objectDigest = sha256(object);
  const manifest = Buffer.from(JSON.stringify({ title: 'Persisted document' }));
  const resourceId = `category/document-${randomUUID()}`;
  const snapshot = {
    resourceId,
    digest: sha256(manifest),
    content: manifest.toString('base64'),
    objectDigests: [objectDigest],
  };

  try {
    await withServer(dataDirectory, async (baseUrl) => {
      const objectWrite = await fetch(`${baseUrl}/v1/objects/${objectDigest}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: object,
      });
      assert.equal(objectWrite.status, 204);

      const manifestWrite = await fetch(
        `${baseUrl}/v1/resources/${encodeURIComponent(resourceId)}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'if-none-match': '*',
          },
          body: JSON.stringify(snapshot),
        },
      );
      assert.equal(manifestWrite.status, 200);
    });

    await withServer(dataDirectory, async (baseUrl) => {
      const inventory = await fetch(`${baseUrl}/v1/resources`);
      assert.equal(inventory.status, 200);
      assert.deepEqual(await inventory.json(), [
        { resourceId, digest: snapshot.digest, version: (await fetch(
          `${baseUrl}/v1/resources/${encodeURIComponent(resourceId)}`,
        ).then((response) => response.json() as Promise<{ version: string }>)).version },
      ]);

      const resourceRead = await fetch(
        `${baseUrl}/v1/resources/${encodeURIComponent(resourceId)}`,
      );
      assert.equal(resourceRead.status, 200);
      const savedSnapshot = await resourceRead.json() as typeof snapshot & { version: string };
      assert.equal(savedSnapshot.digest, snapshot.digest);
      assert.equal(savedSnapshot.content, snapshot.content);
      assert.deepEqual(savedSnapshot.objectDigests, [objectDigest]);

      const objectRead = await fetch(`${baseUrl}/v1/objects/${objectDigest}`);
      assert.equal(objectRead.status, 200);
      assert.deepEqual(Buffer.from(await objectRead.arrayBuffer()), object);
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('rejects stale versions without replacing the latest resource', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'qsuite-sync-server-'));
  const resourceId = `document-${randomUUID()}`;
  const createSnapshot = (text: string) => {
    const content = Buffer.from(text);
    return {
      resourceId,
      digest: sha256(content),
      content: content.toString('base64'),
      objectDigests: [],
    };
  };

  try {
    await withServer(dataDirectory, async (baseUrl) => {
      const endpoint = `${baseUrl}/v1/resources/${encodeURIComponent(resourceId)}`;
      const firstWrite = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify(createSnapshot('first')),
      });
      assert.equal(firstWrite.status, 200);
      const firstVersion = firstWrite.headers.get('etag');
      assert.ok(firstVersion);

      const secondWrite = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': firstVersion },
        body: JSON.stringify(createSnapshot('second')),
      });
      assert.equal(secondWrite.status, 200);

      const staleWrite = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': firstVersion },
        body: JSON.stringify(createSnapshot('stale')),
      });
      assert.equal(staleWrite.status, 409);
      assert.equal((await staleWrite.json() as { error: { code: string } }).error.code, 'version_conflict');

      const latest = await fetch(endpoint);
      const latestResource = await latest.json() as { content: string };
      assert.equal(Buffer.from(latestResource.content, 'base64').toString(), 'second');
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('allows only one concurrent update from the same expected version', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'qsuite-sync-server-'));
  const resourceId = `document-${randomUUID()}`;
  const makeSnapshot = (text: string) => {
    const content = Buffer.from(text);
    return {
      resourceId,
      digest: sha256(content),
      content: content.toString('base64'),
      objectDigests: [],
    };
  };

  try {
    await withServer(dataDirectory, async (baseUrl) => {
      const endpoint = `${baseUrl}/v1/resources/${encodeURIComponent(resourceId)}`;
      const created = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify(makeSnapshot('base')),
      });
      const expectedVersion = created.headers.get('etag');
      assert.equal(created.status, 200);
      assert.ok(expectedVersion);

      const updates = await Promise.all([
        fetch(endpoint, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'if-match': expectedVersion },
          body: JSON.stringify(makeSnapshot('left')),
        }),
        fetch(endpoint, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'if-match': expectedVersion },
          body: JSON.stringify(makeSnapshot('right')),
        }),
      ]);
      assert.deepEqual(updates.map((response) => response.status).sort(), [200, 409]);
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('rejects corrupt objects and manifests with unavailable references', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'qsuite-sync-server-'));
  const resourceId = `document-${randomUUID()}`;
  const manifestBytes = Buffer.from('manifest');
  const missingObject = sha256(Buffer.from('not uploaded'));

  try {
    await withServer(dataDirectory, async (baseUrl) => {
      const invalidObject = await fetch(`${baseUrl}/v1/objects/${sha256(Buffer.from('expected'))}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('corrupt'),
      });
      assert.equal(invalidObject.status, 400);

      const missingReference = await fetch(
        `${baseUrl}/v1/resources/${encodeURIComponent(resourceId)}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'if-none-match': '*',
          },
          body: JSON.stringify({
            resourceId,
            digest: sha256(manifestBytes),
            content: manifestBytes.toString('base64'),
            objectDigests: [missingObject],
          }),
        },
      );
      assert.equal(missingReference.status, 400);
      assert.equal((await missingReference.json() as { error: { code: string } }).error.code, 'invalid_data');
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
