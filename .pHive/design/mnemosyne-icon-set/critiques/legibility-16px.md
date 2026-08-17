# Mnemosyne Icon Set — Legibility Review at 16px

**Reviewer lens, and only this lens:** does the concept survive rendering as a literal 16×16 (or 32×32) browser-tab favicon? I looked at each image at full size and then mentally (and by squinting/backing away from) scaled it down to icon-sized rendering, asking one question per concept: at that scale, is this a recognizable shape, or does it collapse into a smear, a fuzzy dot, or an ambiguous blob? This is not a review of concept fit, brand meaning, or general craft — several of the weaker entries here are perfectly good ideas that simply don't belong on a 16px canvas.

A few things matter more than anything else at this size:
- **Line weight vs. gap.** Thin strokes that sit close together (parallel lines, concentric rings, tight spirals) are the single fastest way to produce mud — anti-aliasing bleeds adjacent strokes into each other before the browser even finishes downscaling.
- **Solid fills beat outlines.** A filled silhouette degrades gracefully (it just gets simpler); an outline shape degrades badly (the outline itself can vanish, leaving nothing).
- **Element count.** Two or three bold shapes read; five or more elements, however cleanly organized at full size, statistically collapse together at 16px.
- **Negative-space detail is the first casualty.** Any information carried by a cutout, notch, or gap thinner than roughly a device pixel at 16px is gone before a human ever sees it.

---

## Per-concept critique

### 1. Memory Spiral / Brain — **fails**
The concept is built entirely on the thing that breaks worst at small sizes: a continuous line making many close, roughly-parallel passes (the spiral coils, then the outer brain-silhouette arcs echoing them at a near-identical radius). At 16px the gaps between adjacent spiral turns are already smaller than a pixel, so the coils fuse into solid rings; combine that with the brain's stem/lobe bump breaking symmetry and you get an irregular gray-gold smudge with no clear read as "brain," "spiral," or anything else. This is the concept most purpose-built to fail this test — worth killing outright for favicon use even if kept for larger marketing marks.

### 2. Laurel Profile — **weak**
It has one thing going for it: it's a solid fill, not an outline, so it degrades gracefully rather than catastrophically. But the identity of this mark lives entirely in fine internal information — the profile's nose/chin/jaw contour and, especially, the laurel leaves, which are carried as thin negative-space cutouts inside the gold shape. Those cutouts are exactly the kind of detail that fills in first at small sizes. What's left at 16px is a plain rounded gold blob with a vague chin notch — it stops reading as a face, and it stops reading as a wreath. You lose the entire "laurel" idea, which was the point of the concept.

### 3. Neural Node Network — **middling**
The five nodes are bold, well-sized filled circles — good, that part holds up. The problem is the connecting lines: thin single-pixel-class strokes linking circles across a fairly wide diamond footprint. At 16px those connectors are the first thing to disappear, and once they do, you're left with 3–5 disconnected dots scattered inside a square — which reads as noise or a die face, not a "network." The concept needs either much fatter connector strokes or fewer, longer edges to survive down-scaling; as drawn, the connective tissue (the entire point of a node-network mark) is the fragile part.

### 4. Scroll & Quill — **weak-to-middling**
The scroll's outer silhouette (a rounded rectangle with curled ends) is a fairly solid, blob-friendly shape and would survive alone. But the mark layers a thin diagonal quill stroke across it, plus a negative-space nib cut into that stroke. At 16px the nib detail vanishes completely, and the diagonal quill line — being both thin and diagonal (diagonals alias worse than horizontals/verticals at low res) — will likely soften into a vague dark smear crossing the scroll rather than a crisp line. The curled scroll ends are also small enough to round off into blobs. Net effect: a rounded gold rectangle with a fuzzy diagonal streak — legible as *something* but not obviously a scroll-and-quill.

### 5. Infinity Recall Loop — **strong**
This is close to a model answer for small-size legibility: one continuous, thick, high-contrast ribbon with no internal detail, no thin sub-elements, and a silhouette (the figure-eight) that's already a widely-recognized symbol even in blurry form. The stroke width is generous relative to the overall mark, so the crossing point in the middle — the one place two strokes overlap — is the only spot at risk of murkiness, and even that reads as "thicker knot in the middle" rather than confusing the shape. This holds its identity from full-size straight down to a browser tab.

### 6. Hourglass Memory — **middling**
Mixed bag. The concentric top/bottom triangle fills (representing sand) are solid and bold, and the overall bowtie/hourglass silhouette is a shape people already recognize instinctively at small sizes (it's a near-universal "loading" glyph, so the brain fills in gaps). Working against it: the frame is a thin outline with a concave waist, which is a harder shape for anti-aliasing to preserve than a straight-edged outline, and the two small dots representing falling memory-grains in the neck are almost certainly going to disappear or fuse into the waist. Likely outcome at 16px: a recognizable bowtie/hourglass silhouette, but the "memory dots falling" storytelling detail is lost — the mark survives, the narrative nuance doesn't.

### 7. Owl (Minimal) — **strong**
The strongest candidate in the set for this lens, and it's not close. Two large filled circles and one small filled triangle — three shapes total, no thin strokes anywhere, generous negative space between the elements so nothing touches or crowds. This is exactly the "reduce until only 2–3 bold shapes remain" strategy that favicon design demands, and the concentric double-circle eyes even survive as a legible ring-in-a-circle at 32px, simplifying further to two solid dots at 16px without becoming ambiguous — two dots and a wedge still parses as a face/owl instantly. This is favicon-native the way most of the other nine concepts are not.

### 8. Ancient Urn — **middling-to-strong**
The vase body is a single, solid, gently-curved silhouette — that part is genuinely favicon-friendly and will hold its "vessel" read even quite small, the same way a wine-glass or trophy glyph reads fine tiny. The risk is entirely in the two handles, which are drawn as thin negative-space loops cut into the gold silhouette near the shoulders. At 16px those loops are likely to close up (the negative space fills solid), which turns "amphora with handles" into "urn/vase without handles" — a real loss of specificity, but not a collapse into noise. Unlike the spiral or the rings, this concept degrades to a *simpler correct shape* rather than to mud, which is the more forgivable failure mode of the two.

### 9. Monogram M / Thread — **strong, with one caveat**
Thick, consistently-weighted strokes throughout, and the overall silhouette is an M — a letterform people can identify from shape alone even badly rendered, because letter recognition is extremely robust to blur. That's a real advantage over the more illustrative concepts. The caveat: the small hook/loop details at the top of each outer stroke (where the "unbroken thread" folds back on itself) are proportionally thin relative to the rest of the mark and sit close to the outer stroke — at 16px these are likely to fuse into a slightly thickened terminal rather than reading as a deliberate loop. That's a minor cosmetic loss, not an identity loss — it still reads as a bold M either way.

### 10. Concentric Memory Rings — **weak**
Same core failure mode as the spiral: multiple thin-to-medium concentric strokes at close, evenly-decreasing radii. Bullseye/target glyphs *can* work small when there are only two rings with real gap between them, but this concept stacks an outer hairline ring, a medium ring, a thicker ring, and a center dot — four concentric elements in one small canvas. At 16px the two inner, bolder rings plus the dot will likely fuse into a single solid gold disc, while the thin outermost ring either disappears or survives as a faint, slightly-too-close halo around that disc. The likely real-world result is "gold dot with a faint ring around it" — not the layered "radiating rings" story the concept wants to tell. Better than the spiral (the symmetry helps it degrade more predictably), worse than almost everything else because it's still fundamentally a stack of thin concentric strokes.

---

## Ranking for THIS lens only (best → worst)

1. **Owl (Minimal)** — three bold shapes, generous spacing, degrades to a still-legible face even at the smallest sizes.
2. **Infinity Recall Loop** — one thick continuous ribbon, no fine detail, silhouette is already a familiar symbol.
3. **Monogram M / Thread** — bold, consistent strokes; letterform recognition covers for the small loop detail loss.
4. **Ancient Urn** — solid vessel silhouette holds up; only the handle detail is at risk, and it fails gracefully.
5. **Neural Node Network** — bold nodes, but the thin connecting lines that make it a "network" are the first thing to go.
6. **Hourglass Memory** — familiar bowtie silhouette survives; the outline waist and memory-dot detail are fragile.
7. **Scroll & Quill** — solid scroll body is fine alone, but the diagonal quill stroke and nib detail smear and vanish respectively.
8. **Laurel Profile** — solid fill keeps it from turning to noise, but the entire "laurel" and "profile" identity lives in negative-space detail that disappears.
9. **Concentric Memory Rings** — too many thin concentric elements; likely collapses to a dot with a faint halo.
10. **Memory Spiral / Brain** — worst case in the set: tightly-packed near-parallel coils that fuse into an irregular smudge with no clear read.

## Strongest candidates through this lens alone

**Owl (Minimal), Infinity Recall Loop, and Monogram M / Thread.** All three share the traits that actually matter for a 16px favicon: two-or-three-shape simplicity or letterform recognizability, no thin parallel or concentric strokes to fuse, and no meaning-carrying detail hiding in negative space. Owl is the clearest win of the set — it's already essentially what a favicon looks like even at full size. Infinity Loop and Monogram M are close behind and would both hold their identity through a full range of install-icon sizes, not just the tab favicon.
