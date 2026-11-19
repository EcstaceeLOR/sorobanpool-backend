#!/usr/bin/env bash
# Fails when the vendored contract artefacts differ from a sorobanpool-contracts ref (#157).
# Usage: scripts/check-contract-artifacts.sh [git-ref | path-to-contracts-repo]
# With no argument it checks against the ref pinned in contracts.ref. Compares SHA-256 checksums of the same four
# files scripts/sync-contract-artifacts.sh copies.
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-$(grep -v '^[[:space:]]*#' contracts.ref | grep -m1 '[^[:space:]]' | tr -d '[:space:]')}"
if [ -z "$REF" ]; then
  echo "no contracts ref given and none pinned in contracts.ref" >&2
  exit 2
fi

FILES=(
  "vectors/pricing-vectors.json:test/fixtures/pricing-vectors.json"
  "artifacts/errors.json:src/chain/artifacts/errors.json"
  "artifacts/events.json:src/chain/artifacts/events.json"
  "deployments/testnet.json:deployments/testnet.json"
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

stale=0
for pair in "${FILES[@]}"; do
  src="${pair%%:*}"
  dst="${pair#*:}"
  if [ -d "$REF" ]; then
    cp "$REF/$src" "$tmp/upstream"
  else
    curl -fsSL "https://raw.githubusercontent.com/SorobanPool/sorobanpool-contracts/$REF/$src" -o "$tmp/upstream"
  fi
  want="$(sha256sum "$tmp/upstream" | cut -d' ' -f1)"
  have="$(sha256sum "$dst" | cut -d' ' -f1)"
  if [ "$want" = "$have" ]; then
    echo "ok     $dst"
  else
    echo "STALE  $dst (contracts $src at $REF is $want, committed copy is $have)"
    stale=1
  fi
done

if [ "$stale" -ne 0 ]; then
  echo
  echo "The vendored contract artefacts differ from sorobanpool-contracts@$REF."
  echo "To fix: run  pnpm sync:contracts $REF  and commit the changed files."
  echo "If the contracts moved on deliberately, sync to the new ref and update contracts.ref to it in the same commit."
  exit 1
fi
echo "Contract artefacts match sorobanpool-contracts@$REF."
