import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const buildRoot = path.join(root, 'dist');
const dataDir = path.join(root, 'data');
const dataFile = path.join(dataDir, 'gastoswell-state.json');

fs.mkdirSync(dataDir, { recursive: true });

function readState() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), 'utf8');
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return sendJson(response, 200, { status: 'ok' });
  }

  if (url.pathname === '/api/state') {
    if (request.method === 'GET') {
      return sendJson(response, 200, readState() || {});
    }
    if (request.method === 'PUT') {
      try {
        const state = await readJson(request);
        writeState(state);
        return sendJson(response, 200, { saved: true });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
  }

  if (url.pathname === '/api/reset' && request.method === 'POST') {
    writeState({});
    return sendJson(response, 200, { reset: true });
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const baseDir = fs.existsSync(path.join(buildRoot, 'index.html')) ? buildRoot : root;
  let filePath;
  try {
    filePath = path.resolve(baseDir, `.${decodeURIComponent(requestedPath)}`);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Invalid path');
    return;
  }
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      if (baseDir === buildRoot && !path.extname(requestedPath)) {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(path.join(buildRoot, 'index.html')).pipe(response);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      fs.createReadStream(filePath).pipe(response);
    }
  });
});

server.listen(port, host, () => {
  console.log(`Gastoswell App running at http://${host}:${port}`);
});
