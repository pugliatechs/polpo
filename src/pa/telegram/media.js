/**
 * Telegram media handling — download photos, voice notes, and documents
 * from Telegram and save them to the polpo uploads directory for agent use.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

var UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');

/**
 * Download a file from Telegram's API and save it to the uploads directory.
 * @param {import('grammy').Bot} bot - grammY bot instance
 * @param {string} fileId - Telegram file_id
 * @param {string} filename - Desired filename (sanitized)
 * @returns {Promise<string>} Full path to the saved file
 */
async function downloadTelegramFile(bot, fileId, filename) {
  // Get file info from Telegram
  var file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('No file_path in Telegram response');
  }

  // Build download URL
  var token = bot.token;
  var url = 'https://api.telegram.org/file/bot' + token + '/' + file.file_path;

  // Sanitize filename
  var safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  var uniqueName = Date.now() + '_' + safeName;

  // Ensure upload dir exists
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  var filePath = path.join(UPLOAD_DIR, uniqueName);

  // Download file
  await new Promise(function (resolve, reject) {
    var mod = url.startsWith('https') ? https : http;
    mod.get(url, function (res) {
      if (res.statusCode !== 200) {
        reject(new Error('Download failed: HTTP ' + res.statusCode));
        return;
      }
      var ws = fs.createWriteStream(filePath);
      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    }).on('error', reject);
  });

  return filePath;
}

/**
 * Get the best photo from a Telegram message (highest resolution).
 * @param {object} photos - Array of PhotoSize objects from ctx.message.photo
 * @returns {{ file_id: string, width: number, height: number } | null}
 */
function getBestPhoto(photos) {
  if (!photos || photos.length === 0) return null;
  // Telegram sends multiple sizes; last one is the largest
  return photos[photos.length - 1];
}

/**
 * Detect media type from file extension.
 * @param {string} filename
 * @returns {string} MIME type
 */
function detectMediaType(filename) {
  var ext = (filename || '').toLowerCase().split('.').pop();
  var types = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    pdf: 'application/pdf',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    mp4: 'video/mp4', webm: 'video/webm',
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = { downloadTelegramFile, getBestPhoto, detectMediaType, UPLOAD_DIR };
