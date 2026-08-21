# Starts a local plaintext HydraDB graph-node on Windows (PowerShell).
# Usage:  $env:HYDRADB_REPO="C:\src\hydradb"; .\scripts\run-hydra.ps1
#
# NOTE: Building the engine natively on Windows requires the Rust toolchain
# plus libcypher-parser and SuiteSparse:GraphBLAS, which are hard to source
# on Windows. If the native build fights you, prefer one of:
#   1. WSL2:  run scripts/run-hydra.sh inside Ubuntu (recommended)
#   2. Docker Desktop:  docker compose up  (see docker-compose.yml)
# Your TypeScript side still runs natively on Windows either way — it only
# needs 127.0.0.1:7687 (Bolt) and 127.0.0.1:8443 (HTTP).

$ErrorActionPreference = "Stop"

if (-not $env:HYDRADB_REPO) {
  Write-Error "Set HYDRADB_REPO to your clone of github.com/hydra-db/hydradb"
}
Set-Location $env:HYDRADB_REPO

New-Item -ItemType Directory -Force -Path ".hydradb\store", ".hydradb\cache" | Out-Null
Set-Content -Path ".hydradb\auth-token" -Value "local-development-token-32-bytes" -NoNewline

$env:CLOUD_PROVIDER              = "local"
$env:LOCAL_PATH                  = "$PWD\.hydradb\store"
$env:GRAPH_NAMESPACE             = "default"
$env:GRAPH_ID                    = "default"
$env:GRAPH_CELL_ID               = "cell-0"
$env:GRAPH_CELLS                 = "cell-0"
$env:GRAPH_NODE_ID               = "node-0"
$env:GRAPH_BOLT_NODE_ADDRESSES   = "node-0=127.0.0.1:7687"
$env:GRAPH_ADVERTISED_BOLT_ADDR  = "127.0.0.1:7687"
$env:GRAPH_DATA_CACHE_DIR        = "$PWD\.hydradb\cache"
$env:GRAPH_AUTH_TOKEN_FILE       = "$PWD\.hydradb\auth-token"
$env:GRAPH_ALLOW_PLAINTEXT       = "true"

# Required: async query futures exceed the default thread stack. Without this
# the node serves /readyz and then aborts on the first query.
$env:RUST_MIN_STACK = "33554432"

Write-Host "Starting graph-node (foreground - this is it working, not hanging)."
Write-Host "Bolt: 127.0.0.1:7687 | HTTP: 127.0.0.1:8443 | Admin: 127.0.0.1:9090"
Write-Host "Verify from another shell with:  npm run bootstrap"
cargo run --locked --features server-runtime --bin graph-node
