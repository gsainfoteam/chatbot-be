const assert = require('node:assert/strict');
const {
  constants,
  brotliCompressSync,
  brotliDecompressSync,
} = require('node:zlib');

// The CVE-2026-111497 fix introduces this permanent block-switch error.
// Check before decoding anything, so this check is safe on old runtimes too.
// https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p
assert.equal(
  constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH,
  -17,
  'CVE-2026-111497: upgrade to Bun >=1.4.4 or a patched Node.js release (see README)',
);

const payload = Buffer.from('chatbot-be Brotli runtime smoke test');
assert.deepEqual(brotliDecompressSync(brotliCompressSync(payload)), payload);

console.log(
  `Brotli runtime check passed (${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`})`,
);
