import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a whole number between 1 and 65535.');
}
const root = __dirname;
const buildRoot = path.join(root, 'dist');
const dataDir = path.join(root, 'data');
const dataFile = path.join(dataDir, 'gastoswell-state.json');
const SESSION_COOKIE = 'gastoswell_session';
const SESSION_MAX_AGE = 12 * 60 * 60;
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();

fs.mkdirSync(dataDir, { recursive: true });

const databaseConfigured = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].some((key) => process.env[key]);
if (databaseConfigured && (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER)) {
  throw new Error('Set DB_HOST, DB_NAME, and DB_USER together in your .env file.');
}
const databasePort = Number(process.env.DB_PORT || 3306);
if (databaseConfigured && (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535)) {
  throw new Error('DB_PORT must be a whole number between 1 and 65535.');
}

const pool = databaseConfigured
  ? mysql.createPool({
      host: process.env.DB_HOST,
      port: databasePort,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    })
  : null;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeState(state) {
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), 'utf8');
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 3_000_000) {
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

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || value.length > 2_500_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedLength && decoded.length !== expectedLength)) {
    return null;
  }
  return decoded;
}

function validatePayload(payload) {
  const ciphertext = payload && decodeBase64(payload.ciphertext);
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    decodeBase64(payload.iv, 12) &&
    ciphertext &&
    ciphertext.length >= 16
  );
}

function validUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9._-]{3,24}$/.test(username);
}

async function hashVerifier(verifier, salt = crypto.randomBytes(16)) {
  const derived = await scrypt(verifier, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyVerifier(verifier, encodedHash) {
  const [scheme, encodedSalt, encodedHashValue] = String(encodedHash || '').split('$');
  const salt = decodeBase64(encodedSalt);
  const expected = decodeBase64(encodedHashValue);
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = await scrypt(verifier, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected);
}

function setSessionCookie(response, token, maxAge = SESSION_MAX_AGE) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/sync; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(response) {
  setSessionCookie(response, '', 0);
}

function getSession(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const token = match.slice(SESSION_COOKIE.length + 1);
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function createSession(response, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_MAX_AGE * 1000 });
  setSessionCookie(response, token);
}

function toPayload(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function syncUnavailable(response) {
  return sendJson(response, 503, { error: 'Encrypted sync is not configured. Set up MySQL in the server .env file.' });
}

function requireSession(request, response) {
  const session = getSession(request);
  if (!session) {
    sendJson(response, 401, { error: 'Sign in again to sync this workspace.' });
    return null;
  }
  return session;
}

async function handleSync(request, response, url) {
  if (!pool) return syncUnavailable(response);

  if (url.pathname === '/api/sync/challenge' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      if (!validUsername(body.username)) return sendJson(response, 400, { error: 'Invalid login name.' });
      const [rows] = await pool.execute('SELECT key_salt FROM users WHERE username = ?', [body.username]);
      return sendJson(response, 200, { salt: rows[0]?.key_salt || crypto.randomBytes(16).toString('base64') });
    } catch (error) {
      if (error.message === 'Invalid JSON' || error.message === 'Request body too large') {
        return sendJson(response, 400, { error: error.message });
      }
      console.error('Could not create sync challenge:', error);
      return sendJson(response, 503, { error: 'Encrypted sync is temporarily unavailable.' });
    }
  }

  if (url.pathname === '/api/sync/register' && request.method === 'POST') {
    let connection;
    try {
      const body = await readJson(request);
      const salt = decodeBase64(body.salt, 16);
      const verifier = decodeBase64(body.verifier, 32);
      if (!validUsername(body.username) ||
          typeof body.id !== 'string' ||
          !/^[A-Za-z0-9._-]{3,64}$/.test(body.id) ||
          !salt || !verifier || !validatePayload(body.payload)) {
        return sendJson(response, 400, { error: 'Invalid encrypted account data.' });
      }

      const passwordHash = await hashVerifier(verifier);
      connection = await pool.getConnection();
      await connection.beginTransaction();
      await connection.execute(
        'INSERT INTO users (id, username, key_salt, password_hash) VALUES (?, ?, ?, ?)',
        [body.id, body.username, body.salt, passwordHash]
      );
      await connection.execute(
        'INSERT INTO encrypted_workspaces (user_id, payload, version) VALUES (?, ?, 1)',
        [body.id, JSON.stringify(body.payload)]
      );
      await connection.commit();
      createSession(response, body.id);
      return sendJson(response, 201, { registered: true, version: 1 });
    } catch (error) {
      if (connection) await connection.rollback();
      if (error.message === 'Invalid JSON' || error.message === 'Request body too large') {
        return sendJson(response, 400, { error: error.message });
      }
      if (error.code === 'ER_DUP_ENTRY') {
        return sendJson(response, 409, { error: 'That login name is already linked to a cloud workspace.' });
      }
      console.error('Could not register encrypted workspace:', error);
      return sendJson(response, 503, { error: 'Encrypted sync is temporarily unavailable.' });
    } finally {
      if (connection) connection.release();
    }
  }

  if (url.pathname === '/api/sync/login' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const verifier = decodeBase64(body.verifier, 32);
      if (!validUsername(body.username) || !verifier) {
        return sendJson(response, 400, { error: 'Invalid login name or password.' });
      }
      const [rows] = await pool.execute(
        `SELECT users.id, users.key_salt, users.password_hash, encrypted_workspaces.payload,
                encrypted_workspaces.version
         FROM users
         INNER JOIN encrypted_workspaces ON encrypted_workspaces.user_id = users.id
         WHERE users.username = ?`,
        [body.username]
      );
      const user = rows[0];
      const valid = user
        ? await verifyVerifier(verifier, user.password_hash)
        : await hashVerifier(verifier, crypto.randomBytes(16)).then(() => false);
      if (!valid) return sendJson(response, 401, { error: 'Invalid login name or password.' });
      createSession(response, user.id);
      return sendJson(response, 200, {
        id: user.id,
        username: body.username,
        salt: user.key_salt,
        payload: toPayload(user.payload),
        version: Number(user.version)
      });
    } catch (error) {
      if (error.message === 'Invalid JSON' || error.message === 'Request body too large') {
        return sendJson(response, 400, { error: error.message });
      }
      console.error('Could not sign in to encrypted workspace:', error);
      return sendJson(response, 503, { error: 'Encrypted sync is temporarily unavailable.' });
    }
  }

  if (url.pathname === '/api/sync/workspace' && ['GET', 'PUT'].includes(request.method)) {
    const session = requireSession(request, response);
    if (!session) return;
    if (request.method === 'GET') {
      try {
        const [rows] = await pool.execute(
          'SELECT payload, version FROM encrypted_workspaces WHERE user_id = ?',
          [session.userId]
        );
        if (!rows.length) return sendJson(response, 404, { error: 'Encrypted workspace not found.' });
        return sendJson(response, 200, { payload: toPayload(rows[0].payload), version: Number(rows[0].version) });
      } catch (error) {
        console.error('Could not load encrypted workspace:', error);
        return sendJson(response, 503, { error: 'Encrypted sync is temporarily unavailable.' });
      }
    }

    try {
      const body = await readJson(request);
      const expectedVersion = Number(body.version);
      if (!validatePayload(body.payload) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return sendJson(response, 400, { error: 'Invalid encrypted workspace update.' });
      }
      const [result] = await pool.execute(
        `UPDATE encrypted_workspaces
         SET payload = ?, version = version + 1
         WHERE user_id = ? AND version = ?`,
        [JSON.stringify(body.payload), session.userId, expectedVersion]
      );
      if (result.affectedRows !== 1) {
        const [rows] = await pool.execute(
          'SELECT payload, version FROM encrypted_workspaces WHERE user_id = ?',
          [session.userId]
        );
        if (!rows.length) return sendJson(response, 404, { error: 'Encrypted workspace not found.' });
        return sendJson(response, 409, {
          error: 'This workspace changed on another device.',
          payload: toPayload(rows[0].payload),
          version: Number(rows[0].version)
        });
      }
      return sendJson(response, 200, { saved: true, version: expectedVersion + 1 });
    } catch (error) {
      if (error.message === 'Invalid JSON' || error.message === 'Request body too large') {
        return sendJson(response, 400, { error: error.message });
      }
      console.error('Could not save encrypted workspace:', error);
      return sendJson(response, 503, { error: 'Encrypted sync is temporarily unavailable.' });
    }
  }

  if (url.pathname === '/api/sync/logout' && request.method === 'POST') {
    const session = getSession(request);
    if (session) sessions.delete(session.token);
    clearSessionCookie(response);
    return sendJson(response, 200, { signedOut: true });
  }

  return sendJson(response, 405, { error: 'Method not allowed' });
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
    return sendJson(response, 200, { status: 'ok', encryptedSync: Boolean(pool) });
  }

  if (url.pathname.startsWith('/api/sync/')) {
    return handleSync(request, response, url);
  }

  if (url.pathname === '/api/state') {
    if (request.method === 'GET') {
      try {
        return sendJson(response, 200, readState() || {});
      } catch (error) {
        console.error('Could not read local state:', error);
        return sendJson(response, 500, { error: 'Local state is unavailable.' });
      }
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

async function startServer() {
  if (pool) {
    await pool.query('SELECT 1');
    const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'key_salt'");
    const [tables] = await pool.query("SHOW TABLES LIKE 'encrypted_workspaces'");
    if (!columns.length || !tables.length) {
      throw new Error('Import database/migrate-encrypted-sync.sql in phpMyAdmin before starting MySQL sync.');
    }
    console.log(`Encrypted sync is using MySQL database "${process.env.DB_NAME}".`);
  } else {
    console.log('Encrypted MySQL sync is disabled; local encrypted profiles remain available.');
  }
  server.listen(port, host, () => {
    console.log(`Gastoswell App running at http://${host}:${port}`);
  });
}

startServer().catch(async (error) => {
  console.error('Gastoswell could not start:', error.message);
  if (pool) await pool.end();
  process.exitCode = 1;
});
