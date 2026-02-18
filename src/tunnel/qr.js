const qrcode = require('qrcode-terminal');

function displayQR(url) {
  console.log('');
  console.log('  Scan this QR code on your phone:');
  console.log('');
  qrcode.generate(url, { small: true }, (qr) => {
    const indented = qr.split('\n').map((line) => '    ' + line).join('\n');
    console.log(indented);
  });
  console.log('');
  console.log(`  Or open: ${url}`);
  console.log('');
}

module.exports = { displayQR };
