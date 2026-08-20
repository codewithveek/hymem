#!/usr/bin/env bash
# Starts a local plaintext HydraDB graph-node, mirroring the hydra-db/hydradb README.
# Usage: HYDRADB_REPO=/path/to/hydradb bash scripts/run-hydra.sh
set -euo pipefail

HYDRADB_REPO="${HYDRADB_REPO:?Set HYDRADB_REPO to your clone of github.com/hydra-db/hydradb}"
cd "$HYDRADB_REPO"

mkdir -p .hydradb/store .hydradb/cache
printf '%s\n' 'local-development-token-32-bytes' > .hydradb/auth-token

export CLOUD_PROVIDER=local
export LOCAL_PATH="$PWD/.hydradb/store"
export GRAPH_NAMESPACE=default
export GRAPH_ID=default
export GRAPH_CELL_ID=cell-0
export GRAPH_CELLS=cell-0
export GRAPH_NODE_ID=node-0
export GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687
export GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687
export GRAPH_DATA_CACHE_DIR="$PWD/.hydradb/cache"
export GRAPH_AUTH_TOKEN_FILE="$PWD/.hydradb/auth-token"
export GRAPH_ALLOW_PLAINTEXT=true

# Required: async query futures exceed the default thread stack. Without this
# the node serves /readyz and then aborts on the first query.
export RUST_MIN_STACK=33554432

# macOS + Homebrew: cargo invoked directly does not inherit the justfile's exports.
if command -v brew >/dev/null; then
  export BINDGEN_EXTRA_CLANG_ARGS="-I$(brew --prefix)/include"
  export LIBRARY_PATH="$(brew --prefix)/lib"
fi

echo "Starting graph-node (foreground — this is it working, not hanging)."
echo "Bolt: 127.0.0.1:7687 · HTTP: 127.0.0.1:8443 · Admin: 127.0.0.1:9090"
echo "Verify from another shell with:  npm run bootstrap"
cargo run --locked --features server-runtime --bin graph-node
