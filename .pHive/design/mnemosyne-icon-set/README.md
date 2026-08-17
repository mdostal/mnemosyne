# Mnemosyne icon set — design pass

**Purpose:** favicon.ico + install/app icon, used across the board (standalone UI tab icon, any future packaged-app icon).

**Generator:** Gemini 3 Pro Image ("Nano Banana Pro", model id `gemini-3-pro-image`), invoked via `portunus resolve --exec` — the API key was never read into this session's own context, only substituted directly into the `curl` subprocess's URL by the `portunus` CLI locally (see Portunus's own boundary-only injection convention). Key reference used: `personalsites-487021-google_generative_ai_api_key` (the only enabled Gemini-capable reference in the shared vault at generation time — reused for this one-time batch with the operator's explicit go-ahead, not a Mnemosyne-scoped key).

**10 initial options** (`options/`), 10 genuinely distinct visual concepts, not variations on one idea — warm amber-gold (#e0a952) line/flat art, dark-favicon-friendly, each independently prompted:

1. `icon-01-memory-spiral-brain.jpg` — continuous spiral line forming a brain silhouette
2. `icon-02-laurel-profile.jpg` — abstracted laurel-wreathed classical profile
3. `icon-03-neural-node-network.jpg` — small knowledge-graph / constellation of nodes
4. `icon-04-scroll-quill.jpg` — rolled scroll + quill mark
5. `icon-05-infinity-recall-loop.jpg` — bold infinity/figure-eight ribbon
6. `icon-06-hourglass-memory.jpg` — hourglass with falling memory-dots
7. `icon-07-owl-minimal.jpg` — reduced geometric owl face
8. `icon-08-ancient-urn-vessel.jpg` — two-handled amphora silhouette
9. `icon-09-monogram-m-thread.jpg` — an M built from one continuous thread
10. `icon-10-concentric-memory-rings.jpg` — concentric rings radiating from a center dot

Saved as JPEG (the model renders "transparent background" as a literal drawn checkerboard rather than true alpha — confirmed via PIL, `mode: RGB`, no alpha channel). This is fine for the review pass below; whichever option is ultimately chosen gets background-keyed to a real transparent PNG (and rasterized to a proper multi-resolution `.ico`) as a separate finishing step, not part of this review.

**Next step (queued, not run yet — operator: "after the rest of the work tonight"):** a multi-swarm design-review pass mirroring `mnemosyne-persona-ux`'s own `pu-01` process exactly — multiple named-persona/lens reviewers independently judge all 10 options, their combined feedback synthesizes down to 3 refined finalists, and the operator makes the final pick from those 3 (not from all 10). See `.pHive/epics/mnemosyne-icon-set-review/` once filed for the concrete ticket breakdown.
