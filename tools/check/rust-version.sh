#!/usr/bin/env bash
# Fails when the Rust version this repository builds with is declared differently in one place
# than another, or when a document promises a floor the workspace does not have.
#
# The checked sources are the ones a build actually reads: Cargo.toml (rust-version),
# rust-toolchain.toml (channel), the CI and security workflows, the container image, and the
# documents that tell a reader which version to install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail=0
want=""

problem() {
    printf '%s\n' "$1" >&2
    fail=1
}

# The workspace floor, which every other declaration has to match.
want="$(sed -n 's/^rust-version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
[ -n "$want" ] || problem "Cargo.toml has no rust-version"

same() { # <file> <actual> <what>
    if [ "$2" != "$want" ]; then
        problem "$1 declares $3 $2, Cargo.toml declares $want"
    fi
}

same rust-toolchain.toml \
    "$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml | head -1)" \
    "channel"

# Every pinned Rust container image in the workflows and the Dockerfile.
images="$(grep -rho 'rust:[0-9][0-9.]*-trixie' .github/workflows deploy/Dockerfile 2>/dev/null | sort -u)"
[ -n "$images" ] || problem "no pinned rust image found in the workflows or the Dockerfile"
while IFS= read -r image; do
    [ -n "$image" ] || continue
    case "$image" in
        "rust:${want}-trixie") ;;
        *) problem "the pinned rust image is $image, expected rust:${want}-trixie" ;;
    esac
done <<< "$images"

# The cargo-deny action's toolchain, which reads the lock file and the policy.
deny_version="$(sed -n 's/^ *rust-version: "\(.*\)"/\1/p' .github/workflows/security.yml | head -1)"
[ -n "$deny_version" ] || problem "security.yml does not pin the cargo-deny rust-version"
if [ -n "$deny_version" ] && [ "$deny_version" != "$want" ]; then
    problem "security.yml pins rust-version $deny_version, Cargo.toml declares $want"
fi

# The documents a reader installs from.
for doc in README.md CONTRIBUTING.md docs/development.md; do
    claimed="$(sed -n "s/.*Rust \([0-9][0-9.]*\) or newer.*/\1/p" "$doc" | head -1)"
    if [ -z "$claimed" ]; then
        problem "$doc does not state the Rust version a reader needs"
    elif [ "$claimed" != "$want" ]; then
        problem "$doc says Rust $claimed or newer, Cargo.toml declares $want"
    fi
done

if [ "$fail" -ne 0 ]; then
    printf '\nRust version declarations differ. The workspace builds with %s.\n' "$want" >&2
    exit 1
fi

printf 'Rust version %s is declared the same way everywhere.\n' "$want"
