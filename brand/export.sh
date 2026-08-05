#!/usr/bin/env bash
# SVG -> PNG.  Requires:  brew install librsvg
# (macOS has no built-in SVG rasteriser; qlmanage is a thumbnailer and anchors content
#  unpredictably inside a square canvas, so it cannot produce exact dimensions.)
set -e
cd "$(dirname "$0")"
command -v rsvg-convert >/dev/null || { echo "need: brew install librsvg"; exit 1; }
R() { rsvg-convert -w "$2" -h "$3" "$1" -o "png/$4"; echo "  png/$4  ${2}x${3}"; }
mkdir -p png
R mark-square.svg          1024 1024 mark-square.png
R mark-square.svg           512  512 mark-512.png
R mark-square.svg           256  256 mark-256.png
R social/avatar.svg        1024 1024 x-avatar-dark.png
R social/avatar-light.svg  1024 1024 x-avatar-light.png
R lockup.svg               1600  629 lockup-light.png
R lockup-dark.svg          1600  629 lockup-dark.png
R lockup.svg                800  314 lockup-light@800.png
R lockup-dark.svg           800  314 lockup-dark@800.png
R social/header.svg        1500  500 x-header.png
R social/og.svg            1200  630 og.png
R favicon.svg               180  180 apple-touch.png
R favicon.svg                32   32 favicon-32.png
