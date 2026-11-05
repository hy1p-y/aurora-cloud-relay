import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

test('statusPage does not leak secrets, QR code, or recent messages', () => {
  const indexSrc = fs.readFileSync('./src/index.ts', 'utf8');
  
  // Verify statusPage does not render TOKEN
  assert.ok(!indexSrc.includes('Auth token for AuroraSuite.exe: <code>${esc(TOKEN)}</code>'), 'Must not render plaintext AUTH_TOKEN in statusPage');
  
  // Verify statusPage does not render public QR SVG
  assert.ok(!indexSrc.includes('wa.pairing && qrSvg ? `<div class="qr">${qrSvg}</div>`'), 'Must not render public WhatsApp QR SVG in statusPage');
  
  // Verify statusPage does not render recent messages
  assert.ok(!indexSrc.includes('<b>Recent traffic</b>'), 'Must not render unauthenticated recent message traffic in statusPage');
});
