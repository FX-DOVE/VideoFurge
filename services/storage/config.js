// Storage configuration from environment. Single place for Drive/Mongo flags.
// Never hardcode credentials; never log secret values.

'use strict';

const path = require('path');

function envBool(env, name, defaultValue = false) {
  const v = env[name];
  if (v == null || v === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function envInt(env, name, defaultValue) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Load storage config from process.env (call after dotenv).
 */
function loadStorageConfig(env = process.env) {
  const enabled = envBool(env, 'GOOGLE_DRIVE_ENABLED', false);
  const authMode = String(env.GOOGLE_DRIVE_AUTH_MODE || 'auto').trim().toLowerCase() || 'auto';
  const defaultToken = path.resolve(__dirname, '..', '..', 'secrets', 'google-oauth-token.json');

  return {
    enabled,
    google: {
      authMode, // oauth | service_account | auto
      credentialsPath: String(env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
      folderId: String(env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
      projectId: String(env.GOOGLE_PROJECT_ID || '').trim(),
      oauthClientId: String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim(),
      oauthClientSecret: String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
      oauthTokenPath: String(env.GOOGLE_OAUTH_TOKEN_PATH || defaultToken).trim(),
      oauthRedirectUri: String(env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:3333/oauth2callback').trim(),
      trashOnDelete: envBool(env, 'GOOGLE_DRIVE_TRASH_ON_DELETE', true),
      maxRetries: envInt(env, 'STORAGE_MAX_UPLOAD_RETRIES', 5),
      retryBaseMs: envInt(env, 'STORAGE_UPLOAD_RETRY_MS', 1000),
      createJobFolders: envBool(env, 'STORAGE_CREATE_JOB_FOLDERS', true),
    },
    mongo: {
      uri: String(env.MONGODB_URI || '').trim(),
      dbName: String(env.MONGODB_DB || 'videofurge').trim() || 'videofurge',
      assetsCollection: String(env.MONGODB_ASSETS_COLLECTION || 'job_assets').trim() || 'job_assets',
    },
    policy: {
      verifySize: envBool(env, 'STORAGE_VERIFY_SIZE', true),
      uploadAllOutputs: envBool(env, 'STORAGE_UPLOAD_ALL_OUTPUTS', true),
      uploadClips: envBool(env, 'STORAGE_UPLOAD_CLIPS', true),
      uploadFrames: envBool(env, 'STORAGE_UPLOAD_FRAMES', true),
      uploadTranscript: envBool(env, 'STORAGE_UPLOAD_TRANSCRIPT', true),
      uploadAudio: envBool(env, 'STORAGE_UPLOAD_AUDIO', true),
      uploadDocs: envBool(env, 'STORAGE_UPLOAD_DOCS', true),
      cleanupIntermediates: envBool(env, 'STORAGE_CLEANUP_INTERMEDIATES', true),
      minLocalBytes: 1000,
    },
  };
}

function resolveEffectiveAuthMode(config) {
  const mode = config.google.authMode || 'auto';
  if (mode === 'oauth' || mode === 'service_account') return mode;
  const fs = require('fs');
  const hasOauth =
    config.google.oauthClientId &&
    config.google.oauthClientSecret &&
    config.google.oauthTokenPath &&
    fs.existsSync(config.google.oauthTokenPath);
  if (hasOauth) return 'oauth';
  if (config.google.credentialsPath && fs.existsSync(config.google.credentialsPath)) {
    return 'service_account';
  }
  if (config.google.oauthClientId && config.google.oauthClientSecret) return 'oauth';
  return 'service_account';
}

/** Whether Drive handoff can run (flag on + required config present). */
function isDriveConfigured(config) {
  if (!config || !config.enabled) return false;
  if (!config.google.folderId || !config.mongo.uri) return false;

  const mode = resolveEffectiveAuthMode(config);
  if (mode === 'oauth') {
    const fs = require('fs');
    return !!(
      config.google.oauthClientId &&
      config.google.oauthClientSecret &&
      config.google.oauthTokenPath &&
      fs.existsSync(config.google.oauthTokenPath)
    );
  }
  return !!(config.google.credentialsPath);
}

/** Human-readable config gaps (no secrets). */
function configGaps(config) {
  if (!config.enabled) return ['GOOGLE_DRIVE_ENABLED is false'];
  const gaps = [];
  if (!config.google.folderId) gaps.push('GOOGLE_DRIVE_FOLDER_ID');
  if (!config.mongo.uri) gaps.push('MONGODB_URI');

  const mode = resolveEffectiveAuthMode(config);
  if (mode === 'oauth') {
    if (!config.google.oauthClientId) gaps.push('GOOGLE_OAUTH_CLIENT_ID');
    if (!config.google.oauthClientSecret) gaps.push('GOOGLE_OAUTH_CLIENT_SECRET');
    const fs = require('fs');
    if (!config.google.oauthTokenPath || !fs.existsSync(config.google.oauthTokenPath)) {
      gaps.push('OAuth token (run: npm run drive:oauth)');
    }
  } else {
    if (!config.google.credentialsPath) gaps.push('GOOGLE_APPLICATION_CREDENTIALS');
  }
  return gaps;
}

module.exports = {
  loadStorageConfig,
  isDriveConfigured,
  configGaps,
  resolveEffectiveAuthMode,
};
