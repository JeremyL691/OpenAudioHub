#!/usr/bin/env bash
# Colour literal audit. The interface takes its colors from the Chalk tokens in
# src/app/globals.css. A color literal may appear only in these sources:
#   src/app/globals.css                                      the token definitions
#   src/lib/notifications/email-templates/brand-colors.ts    the fixed colors (email palette, mark gradient, theme color)
#   the OG image routes (docs-og, opengraph), which render through Satori and need sRGB
# The audit fails when a literal appears anywhere else under src/app, src/components, or src/lib.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pattern='["'"'"'`]#[0-9a-fA-F]{3,8}["'"'"'`]|rgba?\(|hsla?\(|oklch\('
hits="$(grep -rnE "$pattern" src/app src/components src/lib --include='*.ts' --include='*.tsx' --include='*.css' \
    | grep -v '^src/app/globals.css:' \
    | grep -v '^src/lib/notifications/email-templates/brand-colors.ts:' \
    | grep -v 'docs-og' \
    | grep -v 'opengraph' \
    | grep -v '\.test\.' || true)"

if [[ -n "$hits" ]]; then
    echo "$hits"
    count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
    echo "color-literal-audit: $count literal(s) outside the allowed sources." >&2
    exit 1
fi
echo "color-literal-audit: no color literals outside the allowed sources."
