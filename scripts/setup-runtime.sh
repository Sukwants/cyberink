#!/usr/bin/env bash
set -euo pipefail
mkdir -p ~/.local/opt ~/.local/bin
cd ~/.local/opt
curl -fsSL --connect-timeout 15 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o node-shasums.txt
archive=$(sed -n 's/^.*  \(node-.*-linux-x64.tar.xz\)$/\1/p' node-shasums.txt)
test -n "$archive"
curl -fsSL --connect-timeout 15 "https://nodejs.org/dist/latest-v24.x/$archive" -o "$archive"
grep " $archive$" node-shasums.txt | sha256sum -c -
tar -xf "$archive"
ln -sfn "$HOME/.local/opt/${archive%.tar.xz}" node
export PATH="$HOME/.local/opt/node/bin:$PATH"
npm install --prefix "$HOME/.local/opt/pnpm" pnpm@10.19.0 --no-audit --no-fund
ln -sfn "$HOME/.local/opt/pnpm/node_modules/.bin/pnpm" "$HOME/.local/bin/pnpm"
node --version
"$HOME/.local/bin/pnpm" --version
