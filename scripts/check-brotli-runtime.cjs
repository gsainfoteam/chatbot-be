const assert = require('node:assert/strict');
const {
  constants,
  brotliCompressSync,
  brotliDecompressSync,
} = require('node:zlib');

// Require a decoder that supports permanent block-switch errors.
// Check before decoding anything, so this check is safe on old runtimes too.
assert.equal(
  constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH,
  -17,
  'Unsupported Brotli decoder: use the runtime versions specified in package.json',
);

const payload = Buffer.from('chatbot-be Brotli runtime smoke test');
assert.deepEqual(brotliDecompressSync(brotliCompressSync(payload)), payload);

console.log(
  `Brotli runtime check passed (${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`})`,
);
