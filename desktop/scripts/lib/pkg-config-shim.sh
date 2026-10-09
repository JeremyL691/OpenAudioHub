#!/bin/sh
# Build-time stand-in for pkg-config, used only for LAME's configure (desktop/scripts/build-ffmpeg.sh).
# LAME 4.0 requires a pkg-config that answers version queries, but its optional frontends are disabled.
# This shim reports a version and never finds a package, so no library from the host is linked.
case "$1" in
  --version) echo 0.29.2; exit 0 ;;
  --atleast-pkgconfig-version) exit 0 ;;
esac
exit 1
