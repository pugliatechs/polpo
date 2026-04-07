/**
 * Voice note handling — download Telegram voice messages and transcribe via OpenAI Whisper.
 *
 * Telegram sends voice notes as OGG/Opus files. We download them,
 * send to OpenAI's Whisper API for transcription, and return the text.
 *
 * Requires: OPENAI_API_KEY or POLPO_PA_WHISPER_API_KEY env var.
 */

const fs = require('fs');
const path = require('path');
const { downloadTelegramFile } = require('./media');

/**
 * Transcribe a voice note via OpenAI Whisper API.
 * @param {string} filePath - Path to the audio file (OGG/Opus)
 * @param {object} [opts] - { apiKey, model, language }
 * @returns {Promise<string>} Transcribed text
 */
async function transcribeAudio(filePath, opts) {
  if (!opts) opts = {};
  var apiKey = opts.apiKey || process.env.POLPO_PA_WHISPER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('No API key for transcription (set OPENAI_API_KEY or POLPO_PA_WHISPER_API_KEY)');
  }

  var model = opts.model || 'whisper-1';
  var fileData = fs.readFileSync(filePath);
  var filename = path.basename(filePath);

  // Build multipart/form-data manually (no external dep)
  var boundary = '----PolpoWhisper' + Date.now();
  var parts = [];

  // model field
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="model"\r\n\r\n' +
    model + '\r\n'
  );

  // language field (optional)
  if (opts.language) {
    parts.push(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="language"\r\n\r\n' +
      opts.language + '\r\n'
    );
  }

  // file field
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
    'Content-Type: audio/ogg\r\n\r\n'
  );

  var header = Buffer.from(parts.join(''));
  var footer = Buffer.from('\r\n--' + boundary + '--\r\n');
  var body = Buffer.concat([header, fileData, footer]);

  var baseUrl = process.env.POLPO_PA_WHISPER_BASE_URL || 'https://api.openai.com/v1';
  var response = await fetch(baseUrl + '/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: body,
  });

  if (!response.ok) {
    var errText = await response.text();
    throw new Error('Whisper API failed (' + response.status + '): ' + errText);
  }

  var data = await response.json();
  return data.text || '';
}

/**
 * Download and transcribe a Telegram voice note.
 * @param {import('grammy').Bot} bot
 * @param {string} fileId - Telegram file_id for the voice note
 * @param {object} [opts] - Transcription options
 * @returns {Promise<string>} Transcribed text
 */
async function downloadAndTranscribe(bot, fileId, opts) {
  var filePath = await downloadTelegramFile(bot, fileId, 'voice.ogg');
  try {
    var text = await transcribeAudio(filePath, opts);
    return text;
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/**
 * Check if voice transcription is available (API key configured).
 * @returns {boolean}
 */
function isTranscriptionAvailable() {
  return Boolean(process.env.POLPO_PA_WHISPER_API_KEY || process.env.OPENAI_API_KEY);
}

module.exports = { transcribeAudio, downloadAndTranscribe, isTranscriptionAvailable };
