#!/bin/bash
# Patch ssh2 native .node requires to .js stubs for Cloudflare Workers compatibility.
# ssh2 has pure JS fallbacks — these stubs just make esbuild happy.

DIR="$(cd "$(dirname "$0")/.." && pwd)"

# cpu-features: replace require of .node with empty module
CPUF="$DIR/node_modules/cpu-features/lib/index.js"
if [ -f "$CPUF" ] && grep -q "cpufeatures.node" "$CPUF"; then
  sed -i "s|require('../build/Release/cpufeatures.node')|{}|g" "$CPUF"
  echo "Patched cpu-features"
fi

# ssh2 crypto: the require is already in try/catch, just stub the .node file as .js
SSHC="$DIR/node_modules/ssh2/lib/protocol/crypto.js"
if [ -f "$SSHC" ] && grep -q "sshcrypto.node" "$SSHC"; then
  sed -i "s|require('./crypto/build/Release/sshcrypto.node')|require('./crypto_stub')|g" "$SSHC"
  echo "module.exports = {};" > "$DIR/node_modules/ssh2/lib/protocol/crypto_stub.js"
  echo "Patched ssh2 crypto"
fi
