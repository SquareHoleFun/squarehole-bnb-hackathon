# WebP reference pixels

The seven PNGs are independent first-frame references for the seven usable WebPs in
`packages/artwork/src/picture-fixtures.ts`. They were made locally with ImageMagick
7.1.2-34: `magick 'input.webp[0]' -strip -depth 8 PNG32:output.png`.
They preserve the decoded WebP pixels, including its lossy compression and alpha.
The tests require exact decoded pixels. There is no lossy tolerance.

The partial-frame `at-pixel-budget.webp` needs one explicit composition: the 3 x 2
ordinary frame goes at the top left of a transparent 4096 x 1024 canvas. ImageMagick's
default frame read filled the unused canvas with opaque black. The reference instead
uses `magick -size 4096x1024 xc:none ordinary.png -gravity northwest -composite -strip
-depth 8 PNG32:at-pixel-budget.png`. This matches libwebp's first display canvas.

`child.mjs` is an injectable failing child for lifecycle tests. It is not a runtime entry.

`wide-png.webp` repeats 128 rows of seeded RGB noise sixteen times on a 2048 x 2048 canvas.
Python `random.Random(211).randbytes(2048*128*3)` supplied the tile. ImageMagick encoded it
losslessly. Its WebP fits the public byte cap, while its PNG exceeds it. This tests the
internal converted-PNG cap without changing the shared judge or its fixture table.

`native-block-parent.mjs` runs the real child with a sharp stub whose `toBuffer`
blocks a libuv worker in FIFO open. The test checks that native wait in `/proc`
before killing the parent. It covers IPC and stdin lifetime pipes. The ready file
only coordinates the test; the production decoder still uses pipes only.

`memory-check.mjs` is the offline container regression. It constructs the review's
790,040-byte EXIF variant from `wide-png.webp`, with a different density for each
of four requests. It runs the real CardService HTTP path and native renderer.
It warms the actual card LRU to 48 MiB with distinct valid padded card PNGs before
each draw. Run it through `infra/server/test/images-start-check.sh`; the script
applies the card service's Compose memory and CPU limits and checks OOM/restarts.
