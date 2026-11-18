# scene.py

Alignment of different shots of one scene (library + a small CLI): the base for
`match.py --scene` / `--scene-refine` — different geometry, possibly another camera.

## Usage

```
python3 scene.py base.jpg target.jpg
```

Prints the alignment parameters (rotation, scale, tilt, homography shifts). The fitting itself
runs through `match.py --scene name a.NEF a.jpg ...`.

## How it works

1. Alignment by edges: rotation by 90 degrees, scale 0.6-1.6, tilt ±4 degrees, then a homography
   from the local shifts of tiles.
2. Blocks of 14 px on a 1024 frame; a block is taken only if its color barely changes under a
   4-pixel shift (edges are filtered out, grass and foliage stay).
3. At most 12 blocks per color cell, otherwise the sky drowns out the rest; a second pass drops
   the worst 15% of blocks.
4. Color is fitted on the blocks in Lab; XMP WB/exposure is not used and is not aligned between
   cameras.

## Notes

Verified only on the Z f (different geometry of the same frame); a real second camera was not
tested. See the numbers in `spec/results.md` ("The `--scene` mode").
