#!/usr/bin/env node
// One-time OAuth setup for personal Gmail → Drive uploads use YOUR storage quota.
//
// Prerequisites (Google Cloud Console → project videofurge):
//   1. Enable "Google Drive API"
//   2. OAuth consent screen → External → add your Gmail as Test user
//   3. Credentials → Create OAuth client ID → Desktop app
//   4. Put Client ID + Secret in .env (see below)
//
// Run:  npm run drive:oauth

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');
const { google } = require('googleapis');
const { DRIVE_SCOPES } = require('../services/googleDrive/googleDriveService');

const PORT = parseInt(process.env.GOOGLE_OAUTH_PORT || '3333', 10);
const REDIRECT = process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;
const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN_PATH
  || path.resolve(__dirname, '..', 'secrets', 'google-oauth-token.json');

function openBrowser(url) {
  const start =
    process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(start, () => {});
}

function waitForCode(port, authUrl) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, `http://localhost:${port}`);
        if (u.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Auth failed</h1><p>${err}</p>`);
          server.close();
          reject(new Error(err));
          return;
        }
        const code = u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>VideoFurge connected to Google Drive</h1><p>You can close this tab.</p>');
        server.close();
        resolve(code);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(port, '127.0.0.1', () => openBrowser(authUrl));
    server.on('error', reject);
  });
}

async function main() {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    console.error(`
Missing OAuth client credentials (needed for personal Gmail).

1. https://console.cloud.google.com/apis/credentials?project=videofurge
2. OAuth consent screen → External → publish or add your Gmail as Test user
3. Create Credentials → OAuth client ID → Desktop app
4. Add to .env:

GOOGLE_DRIVE_AUTH_MODE=oauth
GOOGLE_OAUTH_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_TOKEN_PATH=${TOKEN_PATH.replace(/\\/g, '/')}
GOOGLE_OAUTH_REDIRECT_URI=${REDIRECT}

5. npm run drive:oauth
`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_SCOPES,
  });

  console.log('\n=== VideoFurge Google Drive OAuth (personal Gmail) ===\n');
  console.log('Sign in with the Gmail that owns folder:', process.env.GOOGLE_DRIVE_FOLDER_ID || '(set GOOGLE_DRIVE_FOLDER_ID)');
  console.log('\nIf the browser does not open, visit:\n\n' + authUrl + '\n');
  console.log('Waiting on', REDIRECT, '…\n');

  const code = await waitForCode(PORT, authUrl);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.warn('WARNING: No refresh_token. Revoke app at https://myaccount.google.com/permissions and re-run.');
  }

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (_) {}

  oauth2.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: oauth2 });
  const about = await drive.about.get({ fields: 'user(emailAddress,displayName)' });
  console.log('Signed in as:', about.data.user?.emailAddress || about.data.user?.displayName);

  const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (folderId) {
    const tmp = path.join(path.dirname(TOKEN_PATH), '_oauth_probe.txt');
    fs.writeFileSync(tmp, `oauth probe ${new Date().toISOString()}\n`);
    try {
      const res = await drive.files.create({
        requestBody: { name: 'videofurge_oauth_probe.txt', parents: [folderId] },
        media: { mimeType: 'text/plain', body: fs.createReadStream(tmp) },
        fields: 'id, name, webViewLink',
      });
      console.log('UPLOAD_OK', res.data.id, res.data.name);
      await drive.files.update({ fileId: res.data.id, requestBody: { trashed: true } });
      console.log('Probe file uploaded successfully (then trashed). OAuth works.');
    } catch (e) {
      console.error('UPLOAD_FAIL', e.message);
      process.exitCode = 1;
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }

  console.log('\nToken saved:', TOKEN_PATH);
  console.log('Ensure .env has: GOOGLE_DRIVE_AUTH_MODE=oauth');
  console.log('Restart server + worker.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
