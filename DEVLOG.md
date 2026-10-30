# Development log (newest first)

## 2026-10-30 — Rebuild from scratch: end-to-end V1 rough draft

The 2025 single-file prototype (Step 1 site drawing + Step 2A analysis layers) was replaced. It is
preserved at commit `09266b2` and copied to `../../_archive/prototype-v1-2025-web/`. The unrelated
Python skeleton from the project root is in `../../_archive/python-skeleton-2025/`.

### Key decisions
- **Browser-only, no build.** ES modules, no dependencies; engine modules are DOM-free and tested in Node.
- **Design frame + 0.5 m design grid.** Building geometry is orthogonal to the frontage, so skewed plots get street-aligned buildings. The plot carries *influence fields* — the spec's "site as spatial influence fields" (§25, §126). The fields are simple distance-decay models, chosen to be legible rather than to simulate.
- **Conservative masks.** A cell is buildable only if it lies wholly inside the setback polygon and outside every preserved tree square and the drive, so footprints built from such cells always comply.
- **Setbacks are mitred** (drawn the way they are drafted), with a one-level straight-skeleton fix for short collapsing edges.
- **Sun path from astronomy** (Cooper declination, standard altitude/azimuth). Facade exposure is integrated over the year with a Chennai heat weighting; west comes out worst, as expected.
- **Access strategies, not positions.** Every gate position is evaluated, then the best of each strategy is shown. The order of entry and exit in an arrival court comes from driving side and road direction (spec §34).
- **Footprints grow adaptively.** Wings grow from anchors until blocked, and tree-anchored rings size each wing from the measured gap around the tree. Selection prefers different families and uses overlap only to remove near-duplicates. Weaknesses shared by every option are reported once, as a "common to all options" note.
- **Bubbles are force-directed ellipses.** Relationships, a strategy field (court / gradient / view), site fields weighted by intent, containment, then a tidy phase. Revisions restart from the selected layout; kept and pinned bubbles never move.
- **Plans use path slicing, not grid growth.** Wings are unrolled into a path and rooms are filled along it in bubble order, so capacity balances and the arrangement is kept. Corridors run only alongside rooms that need their own door. The stair gets a fixed stair hall on every floor.
- **Language layer is rule-based and inspectable** (`interpret.js`). Interpreted items appear as chips before anything is applied. An LLM interpreter can later return the same item/command shapes.

### Research notes (secondary sources — verify before relying on them)
- NBC 2016 Part 3 minimum room sizes, as reported: habitable room 9.5 m² (one room) / 7.5 m² (others); kitchen 5.0 m², min width 1.8 m; bath 1.8 m², min width 1.2 m; WC 1.1 m², min width 0.9 m; combined bath+WC 2.8 m² (some bye-laws: 2.0 m²). Sources: infralens.in NBC 2016 Part 3 summaries; studiomatrx.org guides.
- TNCDBR 2019: base FSI for non-high-rise reported as 2.0; front/side/rear 3 / 1.5 / 1.5 m for ordinary buildings (secondary); G.O. 194 reportedly raises the high-rise threshold from 18.3 m to 19.5 m. Sources: Indian Kanoon extracts of Rule 35; community.verified.realestate; dtnext.in.
- Chennai winds: sea breeze from the E–SE on most summer afternoons; westerly flow from the SW monsoon; NE monsoon Oct–Dec (literature on Chennai sea-breeze climatology).
- Layout generation precedents: Lopes et al. 2010, *A constrained growth method for procedural floor plan generation* (GAME-ON); Merrell et al. 2010, *Computer-generated residential building layouts* (cost-driven stochastic optimisation). This prototype borrows their ideas of explicit cost components and constrained growth, but uses wing/path slicing for cleaner orthogonal plans.

### Known limitations (next round)
- **Plans are the roughest stage.** On tight courtyard rings, some rooms are reached through others and some fall below minimum widths. These are flagged as issues, not hidden. Next: a circulation-first spine per floor, smarter suite carving, plan variants that differ more.
- Bubble strategies can converge on very constrained footprints, so the three options look alike.
- No per-element lock types beyond pin (position) and area lock; no explicit "lock adjacency".
- Upper floors repeat the ground footprint (no terraces or cantilevers yet). Double-height voids come from the room below.
- Context buildings, noise and privacy are simple fields; no shadow or acoustic simulation.
- Access paths are straight or U-shaped; no turning-radius check.
- History snapshots are kept in localStorage (bounded to 120). Export JSON to keep a project safely.
