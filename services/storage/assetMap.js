// Canonical map of deliverable assets. Single source of truth for paths & API keys.
// Do not scatter final.mp4 / acted.mp4 strings across server and worker.

'use strict';

/**
 * assetKey → descriptors used by finalize, download, preview, getJobAssets.
 */
const ASSET_DEFS = {
  final: {
    assetKey: 'final',
    filename: 'final.mp4',
    originalFilename: 'final.mp4',
    localRelative: ['output', 'final.mp4'],
    downloadParam: 'video',
    previewParam: 'video',
    mimeType: 'video/mp4',
    legacyBool: 'video',
    isVideo: true,
  },
  acted: {
    assetKey: 'acted',
    filename: 'acted.mp4',
    originalFilename: 'acted.mp4',
    localRelative: ['output', 'acted.mp4'],
    downloadParam: 'acted',
    previewParam: 'acted',
    mimeType: 'video/mp4',
    legacyBool: 'acted',
    isVideo: true,
  },
  edited: {
    assetKey: 'edited',
    filename: 'edited.mp4',
    originalFilename: 'edited.mp4',
    localRelative: ['output', 'edited.mp4'],
    downloadParam: 'edited',
    previewParam: 'edited',
    mimeType: 'video/mp4',
    legacyBool: 'edited',
    isVideo: true,
  },
  concat: {
    assetKey: 'concat',
    filename: 'concat-video.mp4',
    originalFilename: 'concat-video.mp4',
    localRelative: ['output', 'concat-video.mp4'],
    downloadParam: 'concat',
    previewParam: 'concat',
    mimeType: 'video/mp4',
    legacyBool: 'concat',
    isVideo: true,
  },
  images: {
    assetKey: 'images',
    filename: 'images.zip',
    originalFilename: 'images.zip',
    localRelative: ['output', 'images.zip'],
    downloadParam: 'images',
    previewParam: null,
    mimeType: 'application/zip',
    legacyBool: 'images',
    isVideo: false,
  },
};

/** Map download/preview route param → assetKey */
const DOWNLOAD_PARAM_TO_KEY = {
  video: 'final',
  acted: 'acted',
  edited: 'edited',
  concat: 'concat',
  images: 'images',
};

function getAssetDef(assetKey) {
  return ASSET_DEFS[assetKey] || null;
}

function assetKeyFromDownloadParam(param) {
  return DOWNLOAD_PARAM_TO_KEY[param] || null;
}

function listPrimaryAssetKeys() {
  return ['final', 'acted', 'edited', 'concat', 'images'];
}

/** Stitch outputs to finalize when present on disk */
function stitchAssetKeys() {
  return ['final', 'acted', 'concat', 'images'];
}

function editAssetKeys() {
  return ['edited'];
}

module.exports = {
  ASSET_DEFS,
  DOWNLOAD_PARAM_TO_KEY,
  getAssetDef,
  assetKeyFromDownloadParam,
  listPrimaryAssetKeys,
  stitchAssetKeys,
  editAssetKeys,
};
