const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getBestPhoto, detectMediaType } = require('../src/pa/telegram/media');

describe('getBestPhoto', () => {
  it('returns null for empty array', () => {
    assert.equal(getBestPhoto([]), null);
    assert.equal(getBestPhoto(null), null);
  });

  it('returns last (largest) photo', () => {
    var photos = [
      { file_id: 'small', width: 90, height: 90 },
      { file_id: 'medium', width: 320, height: 320 },
      { file_id: 'large', width: 800, height: 800 },
    ];
    var best = getBestPhoto(photos);
    assert.equal(best.file_id, 'large');
    assert.equal(best.width, 800);
  });

  it('returns single photo', () => {
    var photos = [{ file_id: 'only', width: 100, height: 100 }];
    assert.equal(getBestPhoto(photos).file_id, 'only');
  });
});

describe('detectMediaType', () => {
  it('detects image types', () => {
    assert.equal(detectMediaType('photo.jpg'), 'image/jpeg');
    assert.equal(detectMediaType('photo.jpeg'), 'image/jpeg');
    assert.equal(detectMediaType('image.png'), 'image/png');
    assert.equal(detectMediaType('anim.gif'), 'image/gif');
    assert.equal(detectMediaType('sticker.webp'), 'image/webp');
  });

  it('detects audio types', () => {
    assert.equal(detectMediaType('voice.ogg'), 'audio/ogg');
    assert.equal(detectMediaType('voice.opus'), 'audio/ogg');
    assert.equal(detectMediaType('song.mp3'), 'audio/mpeg');
  });

  it('detects document types', () => {
    assert.equal(detectMediaType('doc.pdf'), 'application/pdf');
  });

  it('returns octet-stream for unknown', () => {
    assert.equal(detectMediaType('file.xyz'), 'application/octet-stream');
    assert.equal(detectMediaType(''), 'application/octet-stream');
  });
});
