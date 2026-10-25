import { createServer } from 'node:http';
import { createApp } from './app.js';
import { FileSystemSyncRepository } from './storage/FileSystemSyncRepository.js';

const host = process.env.SYNC_SERVER_HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const dataDirectory = process.env.SYNC_SERVER_DATA_DIR ?? './data';

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535.');
}

const repository = new FileSystemSyncRepository(dataDirectory);
await repository.initialize();

const server = createServer(createApp({ dataDirectory }));
server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.info(`SyncServer listening at http://${host}:${listeningPort}`);
  console.info(`Sync data directory: ${dataDirectory}`);
});

/** Stop accepting HTTP requests and exit after the server has closed. */
function shutdown(signal: NodeJS.Signals): void {
  server.close((error) => {
    if (error) {
      console.error(`Failed to stop SyncServer after ${signal}:`, error);
      process.exitCode = 1;
      return;
    }
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
