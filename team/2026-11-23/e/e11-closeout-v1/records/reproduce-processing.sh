#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Requires ImageMagick 7. Writes only the named local sample outputs.
magick sources/base-front-expression-ready.png sources/wardrobe-f01-neutral-1024w.png -composite sources/wardrobe-s02-leaf-cape-1024w.png -composite samples/moment-r2-reference-1024w.png
magick sources/moment-character-attempt-02.png -filter point -resize 300x300! +dither -colors 96 -filter point -resize 1200x1200! -alpha off samples/moment-r2-shell-candidate-1200w.png
for side in exterior interior; do
 magick "sources/scene-${side}-watermark-edited.png" -crop 1254x1070+0+150 +repage -filter point -resize 375x320! +dither -colors 96 -filter point -resize 750x640! "samples/scene-bookstore-${side}-750w.png"
done
# ImageMagick version can change encoding bytes; visually inspect and regenerate checks if intentionally rerunning.
