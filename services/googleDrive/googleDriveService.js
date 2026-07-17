// Google Drive adapter ONLY. Auth, stream upload, retry, lookup, metadata, delete.
// Auth modes:
//   - oauth           (personal Gmail — uses YOUR Drive storage quota)
//   - service_account (Workspace Shared drives only; My Drive has 0 SA quota)
//   - auto            prefer oauth if token file exists, else service account

'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const TRANSIENT_CODES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_NET = /econnreset|etimedout|econnrefused|epipe|socket hang up|network|rate limit|timeout/i;
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isTransientError(err) {
  if (!err) return false;
  const code = err.code || err.status || err.response?.status;
  if (TRANSIENT_CODES.has(Number(code))) return true;
  const msg = String(err.message || err || '');
  return TRANSIENT_NET.test(msg);
}

function mapFileMeta(data) {
  if (!data) return null;
  return {
    driveFileId: data.id,
    name: data.name || null,
    mimeType: data.mimeType || null,
    size: data.size != null ? parseInt(data.size, 10) : null,
    md5Checksum: data.md5Checksum || null,
    driveViewUrl: data.webViewLink || (data.id ? `https://drive.google.com/file/d/${data.id}/view` : null),
    driveDownloadUrl: data.webContentLink || (data.id ? `https://drive.google.com/uc?id=${data.id}&export=download` : null),
    thumbnailUrl: data.thumbnailLink || null,
    parents: Array.isArray(data.parents) ? data.parents : [],
  };
}

function resolveAuthMode(options) {
  const mode = String(options.authMode || 'auto').toLowerCase().trim();
  if (mode === 'oauth' || mode === 'service_account') return mode;
  // auto
  const tokenPath = options.oauthTokenPath || '';
  const hasToken = tokenPath && fs.existsSync(tokenPath);
  const hasOauthClient = !!(options.oauthClientId && options.oauthClientSecret);
  if (hasToken && hasOauthClient) return 'oauth';
  if (options.credentialsPath && fs.existsSync(options.credentialsPath)) return 'service_account';
  if (hasOauthClient) return 'oauth';
  return 'service_account';
}

/**
 * @param {object} options
 * @param {string} [options.authMode]  oauth | service_account | auto
 * @param {string} [options.credentialsPath]  SA JSON path
 * @param {string} [options.oauthClientId]
 * @param {string} [options.oauthClientSecret]
 * @param {string} [options.oauthTokenPath]
 * @param {string} [options.oauthRedirectUri]
 * @param {string} [options.projectId]
 * @param {number} [options.maxRetries]
 * @param {number} [options.retryBaseMs]
 * @param {function} [options.onRetry]
 */
function createGoogleDriveService(options = {}) {
  const maxRetries = Math.max(1, Number(options.maxRetries) || 5);
  const retryBaseMs = Math.max(100, Number(options.retryBaseMs) || 1000);
  const authMode = resolveAuthMode(options);

  let drive = null;
  let authClient = null;

  async function authenticate() {
    if (drive) return drive;

    let google;
    try {
      google = require('googleapis').google;
    } catch (e) {
      throw new Error('googleapis package is not installed. Run: npm install googleapis');
    }

    if (authMode === 'oauth') {
      authClient = await buildOAuthClient(google, options);
    } else {
      authClient = await buildServiceAccountClient(google, options);
    }

    drive = google.drive({ version: 'v3', auth: authClient });
    return drive;
  }

  async function buildServiceAccountClient(google, opts) {
    const credentialsPath = opts.credentialsPath || '';
    if (!credentialsPath) {
      throw new Error(
        'Service account mode: set GOOGLE_APPLICATION_CREDENTIALS. ' +
        'Note: personal Gmail cannot use SA for file uploads — use GOOGLE_DRIVE_AUTH_MODE=oauth instead.'
      );
    }
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Service account file not found: ${credentialsPath}`);
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: DRIVE_SCOPES,
      projectId: opts.projectId || undefined,
    });
    return auth.getClient();
  }

  async function buildOAuthClient(google, opts) {
    const clientId = opts.oauthClientId || '';
    const clientSecret = opts.oauthClientSecret || '';
    const tokenPath = opts.oauthTokenPath || '';
    const redirectUri = opts.oauthRedirectUri || 'http://localhost:3333/oauth2callback';

    if (!clientId || !clientSecret) {
      throw new Error(
        'OAuth mode requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET. ' +
        'Create an OAuth "Desktop" client in Google Cloud Console, then run: npm run drive:oauth'
      );
    }
    if (!tokenPath || !fs.existsSync(tokenPath)) {
      throw new Error(
        `OAuth token file missing (${tokenPath || 'GOOGLE_OAUTH_TOKEN_PATH'}). ` +
        'Run once: npm run drive:oauth  (signs in with your personal Gmail; uses your Drive quota)'
      );
    }

    let tokens;
    try {
      tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read OAuth token file: ${e.message}`);
    }
    if (!tokens.refresh_token && !tokens.access_token) {
      throw new Error('OAuth token file has no refresh_token. Re-run: npm run drive:oauth');
    }

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2.setCredentials(tokens);

    // Persist refreshed access tokens
    oauth2.on('tokens', (newTokens) => {
      try {
        const merged = { ...tokens, ...newTokens };
        if (!merged.refresh_token && tokens.refresh_token) {
          merged.refresh_token = tokens.refresh_token;
        }
        fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2), 'utf8');
        tokens = merged;
      } catch (_) {}
    });

    return oauth2;
  }

  async function withRetry(label, fn) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        const transient = isTransientError(err);
        if (!transient || attempt >= maxRetries) {
          const e = new Error(`${label} failed: ${err.message || err}`);
          e.cause = err;
          e.code = err.code || err.status || err.response?.status;
          e.attempts = attempt;
          throw e;
        }
        const delay = retryBaseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        if (typeof options.onRetry === 'function') {
          options.onRetry({ label, attempt, delay, error: String(err.message || err) });
        }
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  async function ensureFolder(name, parentId) {
    const api = await authenticate();
    const safeName = String(name || 'folder').replace(/'/g, "\\'");
    const q = [
      `name = '${safeName}'`,
      `'${parentId}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      'trashed = false',
    ].join(' and ');

    return withRetry('drive.ensureFolder', async () => {
      const list = await api.files.list({
        q,
        fields: 'files(id, name)',
        spaces: 'drive',
        pageSize: 5,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const existing = list.data.files && list.data.files[0];
      if (existing && existing.id) return existing.id;

      const created = await api.files.create({
        requestBody: {
          name: String(name),
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        },
        fields: 'id, name',
        supportsAllDrives: true,
      });
      if (!created.data || !created.data.id) {
        throw new Error('ensureFolder: no id returned');
      }
      return created.data.id;
    });
  }

  async function uploadFile({ localPath, filename, mimeType, folderId }) {
    if (!localPath || !fs.existsSync(localPath)) {
      throw new Error(`uploadFile: local file missing: ${localPath}`);
    }
    if (!folderId) throw new Error('uploadFile: folderId required');
    const api = await authenticate();
    const name = filename || path.basename(localPath);
    const mime = mimeType || 'application/octet-stream';

    return withRetry('drive.upload', async () => {
      const body = fs.createReadStream(localPath);
      try {
        try {
          const res = await api.files.create({
            requestBody: {
              name,
              parents: [folderId],
            },
            media: {
              mimeType: mime,
              body,
            },
            fields: 'id, name, mimeType, size, md5Checksum, webViewLink, webContentLink, thumbnailLink, parents',
            supportsAllDrives: true,
          });
          const meta = mapFileMeta(res.data);
          if (!meta || !meta.driveFileId) {
            throw new Error('uploadFile: no driveFileId in response');
          }
          meta.driveFolderId = folderId;
          return meta;
        } catch (err) {
          const msg = String(err && err.message || err);
          if (/storage quota|Service Accounts do not have storage quota/i.test(msg)) {
            const e = new Error(
              'Service accounts cannot upload into personal My Drive (0 quota). ' +
              'You are on a personal Gmail — set GOOGLE_DRIVE_AUTH_MODE=oauth and run: npm run drive:oauth'
            );
            e.cause = err;
            e.code = err.code || err.response?.status;
            throw e;
          }
          throw err;
        }
      } finally {
        if (body && typeof body.destroy === 'function') {
          try { body.destroy(); } catch (_) {}
        }
      }
    });
  }

  async function getFileMetadata(fileId) {
    if (!fileId) throw new Error('getFileMetadata: fileId required');
    const api = await authenticate();
    return withRetry('drive.getFileMetadata', async () => {
      const res = await api.files.get({
        fileId,
        fields: 'id, name, mimeType, size, md5Checksum, webViewLink, webContentLink, thumbnailLink, parents',
        supportsAllDrives: true,
      });
      return mapFileMeta(res.data);
    });
  }

  async function fileExists(fileId) {
    try {
      await getFileMetadata(fileId);
      return true;
    } catch (err) {
      const code = err.code || err.cause?.code || err.cause?.response?.status;
      if (Number(code) === 404) return false;
      throw err;
    }
  }

  async function findFileByName(folderId, name) {
    const api = await authenticate();
    const safeName = String(name || '').replace(/'/g, "\\'");
    const q = [
      `name = '${safeName}'`,
      `'${folderId}' in parents`,
      'trashed = false',
    ].join(' and ');
    return withRetry('drive.findFileByName', async () => {
      const list = await api.files.list({
        q,
        fields: 'files(id, name, mimeType, size)',
        spaces: 'drive',
        pageSize: 5,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const f = list.data.files && list.data.files[0];
      return f && f.id ? { id: f.id, name: f.name } : null;
    });
  }

  async function getFileStream(fileId) {
    if (!fileId) throw new Error('getFileStream: fileId required');
    const api = await authenticate();
    return withRetry('drive.getFileStream', async () => {
      const res = await api.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      const stream = res.data;
      if (!stream || typeof stream.pipe !== 'function') {
        if (Buffer.isBuffer(stream) || typeof stream === 'string') {
          return Readable.from(stream);
        }
        throw new Error('getFileStream: unexpected response type');
      }
      return stream;
    });
  }

  async function deleteFile(fileId, { permanent = false } = {}) {
    if (!fileId) return;
    const api = await authenticate();
    try {
      await withRetry('drive.deleteFile', async () => {
        if (permanent) {
          await api.files.delete({ fileId, supportsAllDrives: true });
        } else {
          await api.files.update({
            fileId,
            requestBody: { trashed: true },
            supportsAllDrives: true,
          });
        }
      });
    } catch (err) {
      const code = Number(err.code || err.cause?.response?.status || 0);
      if (code === 404) return;
      throw err;
    }
  }

  async function deleteFolder(folderId, opts) {
    return deleteFile(folderId, opts);
  }

  return {
    authenticate,
    uploadFile,
    getFileMetadata,
    fileExists,
    findFileByName,
    getFileStream,
    deleteFile,
    deleteFolder,
    ensureFolder,
    isTransientError,
    getAuthMode: () => authMode,
  };
}

module.exports = {
  createGoogleDriveService,
  isTransientError,
  mapFileMeta,
  resolveAuthMode,
  DRIVE_SCOPES,
};
