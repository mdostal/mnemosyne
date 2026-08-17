# Multi-Resolution Scalability Critique — Mnemosyne Icon Set

**Lens:** Does the shape and line weight of each concept hold together across the full favicon-to-install-icon range (roughly 16x16 up through 512x512), with a single consistent treatment — no size-specific redraw needed to keep it legible? General aesthetic quality, brand fit, and conceptual resonance with "memory" are out of scope here; this is purely about geometric robustness under scale.

I looked at each of the ten JPEGs directly (all rendered at a single large reference size, so I'm judging what will happen as that same artwork is compressed down, not comparing pre-optimized multi-size exports).

---

## Per-concept notes

### 1. Memory Spiral / Brain — icon-01-memory-spiral-brain.jpg
The concept is built entirely from a single stroke, but that stroke coils through roughly five tight turns with narrow gaps between rings, plus small notch details where the brain silhouette pokes out (temporal lobe bump, stem). At large sizes this reads clearly and the "single continuous line" idea is legible. Shrunk to favicon size, the gaps between spiral turns are the first casualty — they close up well before 32px, and the whole mark collapses into a solid blob or a muddy asterisk. The brain-silhouette notches are even smaller than the spiral pitch, so they disappear first. This is a concept that fundamentally depends on being able to resolve five concentric turns, which is a much higher line-count budget than a small icon has. **Weakest scaler in the set.**

### 2. Laurel Profile — icon-02-laurel-profile.jpg
The outer silhouette (head + wreath mass) is a single confident blob, which is the right instinct for scaling. But the internal detail — the negative-space laurel leaves cut into the wreath, the fine profile line for nose/lips/chin, and the thin neck stroke hanging below the jaw — are all much finer than the outer silhouette. At small sizes the leaf cutouts will fill in (turning the wreath into a plain gold dome) and the thin neck line will either vanish or turn into a stray dark speck detached from the head. The concept doesn't fail outright — the head-with-wreath gestalt survives — but it needs a genuinely different, simplified inner treatment at small sizes than the one shown, which is exactly the failure mode this lens is checking for.

### 3. Neural Node Network — icon-03-neural-node-network.jpg
Five filled circles joined by straight connector strokes. This is a fairly good scaling structure: there are only two element types (dot, line), both are geometrically simple, and the dots are large relative to the connectors, so they'll stay visible even after the connecting lines thin to hairlines. The main risk is the connector lines — at 16px they may thin out or anti-alias into faint gray threads, leaving five dots that read as a loose cluster rather than a network. Still, because the dots alone preserve a recognizable "constellation" silhouette even if the lines wash out, the concept degrades gracefully rather than collapsing. Solid mid-tier performer.

### 4. Scroll & Quill — icon-04-scroll-quill.jpg
The scroll body is a bold, confident silhouette, which is good. But the two curled ends (top-left and bottom-right spiral flourishes) are fine, tightly-wound details similar in spirit to the memory-spiral problem, just smaller in scope — at icon size they'll blur into rounded blobs rather than reading as scroll curls. The diagonal quill is rendered as negative space cut through the scroll body; that negative-space shape is reasonably bold and should survive down to a moderate size, but combined with the curls it adds a second competing detail layer. Two different fine-detail elements (curls + quill notch) means two different failure points as it shrinks, rather than one clean silhouette.

### 5. Infinity Recall Loop — icon-05-infinity-recall-loop.jpg
A single thick ribbon, closed shape, no fine internal detail, no thin appendages. The stroke width is a large fraction of the overall glyph height, and the two open "holes" in the loop are wide relative to the ribbon — meaning even as this shrinks, the holes won't fill in and the ribbon won't disappear into hairlines. This is close to an ideal profile for scaling: one shape, one weight, generous negative space that stays open. The only mild concern is the crossover point at the center, where two ribbon edges meet at a shallow angle — at extreme small sizes (favicon-tab scale) that crossing can compress into a slightly muddy pinch, but it won't break the overall "infinity" read. **One of the strongest scalers in the set.**

### 6. Hourglass Memory — icon-06-hourglass-memory.jpg
The outer hourglass contour is a thin, uniform-weight outline, and it pinches to a sharp point at the waist — a shape that is hard for anti-aliasing to hold cleanly at small sizes; sharp acute-angle vertices are one of the first things to go soft/blurry when a mark is downsized. On top of that, the small circular "falling memory dots" in the middle are tiny relative to the frame and will vanish well before the outline does, and the filled sand-triangles at top and bottom are the only truly bold shapes here. So this concept is built from three different weight tiers (thin outline, tiny dots, bold triangles) that will each hit their breaking point at a different size — the opposite of a single consistent treatment. Weak scaler.

### 7. Owl (Minimal) — icon-07-owl-minimal.jpg
Two large filled circles and one small filled triangle. There is essentially no fine detail to lose — even the subtle inner-ring shading on the eyes is a soft value shift rather than a hard edge, so it can be dropped or simplified with no structural change to the mark. The three shapes are large, bold, and maximally separated from each other, so they won't merge or clot at small sizes the way tightly-packed details do elsewhere in this set. This is about as close to "reads the same at 16px and 512px" as a representational mark can get. **Strongest scaler in the set.**

### 8. Ancient Urn — icon-08-ancient-urn-vessel.jpg
A single bold, confident silhouette with two open handle loops. The vessel body itself will scale beautifully — it's a big, simple, well-proportioned blob with no fine internal linework. The handles are the one soft spot: each is a moderately narrow open loop, and at favicon size those apertures are the kind of detail that can fill in, turning the handles into two solid bumps rather than open loops. That's a real but fairly forgiving failure mode — the urn still reads as "vessel" even if the handles solidify, it just loses some of its Greek-pottery specificity at the smallest sizes. Good mid-to-upper-tier performer.

### 9. Monogram M / Thread — icon-09-monogram-m-thread.jpg
A thick, continuous, rounded-terminal stroke forming an M, with generous open counters (the two "window" gaps at top-left and top-right, and the open space under the peak of the M). The stroke weight is heavy and consistent throughout — there's no thin segment anywhere in the mark that would be the first to disappear — and the open counters are wide enough that they should stay open even compressed to a small square. This is a letterform built the way favicon letterforms should be: bold weight, generous counters, no serif-like fine terminals. Behaves very similarly to a well-drawn wordmark glyph, which is exactly the discipline that makes marks legible at tiny sizes. **Strong scaler, arguably tied for best in the set.**

### 10. Concentric Memory Rings — icon-10-concentric-memory-rings.jpg
This one is instructive because it mixes weights within a single concept: the center dot and the ring immediately around it are bold and filled, but the two outer rings are drawn as progressively thinner hairline strokes. At large size that gradation reads as an intentional "ripple fading outward" effect. At small size, the thin outer rings are the first casualty — they'll alias or vanish, leaving an inconsistent result depending on exact pixel size (sometimes 2 rings visible, sometimes 3, sometimes just the center dot and one ring). That inconsistency across sizes — not merely "loses detail" but "renders as a visibly different mark depending on which size you're looking at" — is the specific failure this lens is meant to catch. If it were redrawn with uniform ring weight it would scale much better, but as submitted it needs a different stroke treatment at each size tier.

---

## Ranking for multi-resolution scalability (best → worst)

1. **Owl (Minimal)** — icon-07 — two dots and a wedge; nothing to lose at any size.
2. **Monogram M / Thread** — icon-09 — bold uniform stroke, generous open counters, letterform discipline.
3. **Infinity Recall Loop** — icon-05 — single thick ribbon, wide open holes, one weight throughout.
4. **Neural Node Network** — icon-03 — dots survive even if connecting lines thin out; graceful degradation.
5. **Ancient Urn** — icon-08 — bold body silhouette; only the handle apertures are at risk.
6. **Laurel Profile** — icon-02 — strong outer blob undermined by fine internal leaf/profile linework.
7. **Concentric Memory Rings** — icon-10 — mixed stroke weights mean the mark literally looks different at different sizes.
8. **Scroll & Quill** — icon-04 — bold body, but two separate fine-detail failure points (curls, quill notch).
9. **Hourglass Memory** — icon-06 — thin outline with an acute pinch point plus tiny dots that vanish early.
10. **Memory Spiral / Brain** — icon-01 — five tight coils need a line-count budget no small icon has; collapses to a blob first.

## Strongest candidates through this lens alone

**Owl (Minimal), Monogram M / Thread, and Infinity Recall Loop.** All three share the traits that actually predict clean scaling: a small number of bold, simple shapes; stroke or fill weight that stays consistent across the whole mark rather than mixing thin and thick elements; and negative-space gaps sized generously enough that they won't close up under compression. None of the three require a size-specific redraw to stay legible — the same artwork should carry believably from a browser tab up to a 512px install icon. If forced to pick a single winner on this lens alone, the Owl is the safest bet: it has zero fine detail to begin with, so there's nothing left to lose as it shrinks.
