# Design Assistant — Prototype V1

A **human-in-the-loop computational design assistant** — a "digital junior architect". It does the
analysis, arithmetic and option generation; the architect selects, locks, modifies and decides.
Every decision is recorded, so the design process itself becomes an output.

```
SITE → ANALYSIS → BUILDABLE REGION → GROUND ZONING → PROGRAMME → BUBBLES → SINGLE-LINE PLANS → DESIGN RECORD
```

## Run it

The app is plain HTML + ES modules (no build step, no dependencies). Browsers block modules on
`file://`, so serve the folder:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765>. VS Code **Live Server** works too. The benchmark project (a corner
plot in Chennai with three existing trees) loads on first run. Projects autosave in the browser;
use *Record & export* to export/import `.json`.

Tests (Node 18+):

```bash
node --test
```

## How a session goes

| Stage | What the system does | What the architect decides |
|---|---|---|
| 00 Brief & intent | Reads the intent text into weighted priorities (rule-based, shown as chips) | Brief, floors, target area, parking, entry character, open spaces, priority weights |
| 01 Site | Validates geometry, finds the frontage, offsets setbacks, FSI/height, real sun path for the latitude, influence fields (noise, overlooking, views, depth, breeze, shade) | Site layers, road widths, regulation assumptions, north |
| 02 Trees | Costs each preserved tree in buildable area (canopy square + 1.5 m) | Preserve / remove — never automatic |
| 03 Access | Evaluates every gate position on every road; returns distinct strategies (side entry, arrival court, axial, split access) with traffic flow from driving side | Select, regenerate |
| 04 Footprint | Grows hundreds of footprints from architectural families (bar, block, L, U, courtyard, pavilions, tree-anchored); hard constraints filter; components scored; three *different* families shown with reasons | Select, three more |
| 05 Programme | Default programme from the brief; area budget (net + circulation + walls + core = gross); auto-balance with locks; floor assignment against footprint capacity; validation | Rooms, areas, locks, floors, relationships; spatial preferences in words |
| 06 Bubbles | Area-true bubbles under adjacency, site fields and one of three strategies (court-centric, privacy gradient, view-oriented) | Select, drag, pin, revise in words, regenerate unpinned |
| 07 Plans | Slices rooms from the footprint wings in bubble order; corridors, suites, stair hall, walls, open partitions, doors; access and size checks | Select a plan variant; issues are listed, not hidden |
| 08 Record | Decision trace, design evolution with branching, output sheets (print to PDF), JSON/SVG export | Branch from any earlier state |

## Principles kept in code

- **Data, not drawings.** The project object is the design state; every SVG is generated from it (`js/core/pipeline.js`, `js/render/draw.js`).
- **Deterministic geometry.** Areas, offsets, containment, fields and scores are computed (`js/geometry`, `js/analysis`). No language model computes anything.
- **Hard vs soft.** Hard constraints (plot, setbacks, tree squares, the drive, area tolerance, locks) filter candidates. Soft constraints are scored components. Heuristics are labelled as heuristics.
- **Explainable alternatives.** Each option keeps its component scores, and its pros and cons are written from its own metrics compared with its siblings.
- **Reversible decisions.** Every select / accept / lock / revision is a history entry with a snapshot. Earlier states can be branched. Upstream changes flag downstream stages as *needs review* instead of silently keeping them.
- **Prototype regulations.** FSI 2, setbacks 3 / 1.5 m, 15 m height and room minimums are labelled assumptions with notes (`js/rules/assumptions.js`). This is not a compliance tool.

## Code map

```
index.html, css/app.css         interface
js/core/      model (project schema, benchmark), store (state, history, persistence), pipeline (derived data, stage staleness), util, rng
js/geometry/  polygon (area, inset, clipping, distances), grid (design frame aligned to the frontage, masks, distance transforms)
js/analysis/  site (validation, frontage, setbacks, controls), sun (solar position & facade exposure), fields (influence fields)
js/rules/     assumptions (regulation package + design constants), spaces (space library), relations (adjacency rules)
js/design/    access, footprint, programme, interpret (rule-based language), bubbles, plan
js/render/    draw (SVG drawing conventions)
js/ui/        app (stages & actions), canvas (pan/zoom/drag), parse (site text formats), components, sheets (output package)
tests/        engine tests (node --test)
```

See `DEVLOG.md` for design decisions, research notes and known limitations.
