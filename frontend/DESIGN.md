# Charito — design system

**Direction: graphite on paper.** Two materials, used twice. The reading pages
(overview, reference, about) are warm uncoated paper with graphite ink. The studio is
the same two materials swapped: graphite ground, paper ink. Nothing else changes between
them, which is why one set of component styles serves both surfaces.

The register is quiet and professional — a technical document rather than a product
pitch. Where the choice was between "interesting" and "credible", credible won.

The system lives in three files: `src/styles/theme.css` (tokens and base),
`src/styles/app.css` (components), `src/styles/fonts.css` (the two faces).

---

## Layering — read this before adding CSS

`app.css` is wrapped in `@layer components`, and that is load-bearing. Tailwind emits its
utilities into `@layer utilities`, and **an unlayered rule beats any layered rule
regardless of specificity**. An unlayered `.btn { display: inline-flex }` therefore
silently defeats `hidden` and `md:hidden` on the same element — which is exactly the bug
that made the mobile menu button appear on desktop.

Two rules follow:

1. New component CSS goes **inside** `@layer components`.
2. Never set `display` in an inline `style` on an element that also carries a Tailwind
   display utility. Inline styles beat every layer, including utilities.

---

## Colour

Colour has exactly two jobs in this interface. Everything else is neutral.

| Token | Light | Dark | Because |
|---|---|---|---|
| `--bg` | `#FBFAF7` | `#1B1A18` | Warm uncoated paper, and the graphite that writes on it. |
| `--ink` | `#1B1A18` | `#FBFAF7` | The same two values, swapped. |
| `--accent` | `#1F4C73` | `#7FB3D9` | Prussian blue, from cyanotype blueprint stock. |
| `--ok` | `#3F6B52` | `#7FB596` | Terre verte. |
| `--warn` | `#8A6520` | `#D6A84F` | Raw sienna. |
| `--bad` | `#8E3B2E` | `#E08573` | Red ochre. |

- **Job one — the accent** marks what is *active, live, selected or focused*. Nothing
  else. It is not on headings, not on links in body copy, not on borders for decoration.
- **Job two — the three earth pigments** carry run state, and only run state.
- **The primary action has no hue at all.** It is solid ink: graphite on paper, paper on
  graphite. That is the most emphatic thing this system can do, and it spends no colour
  doing it — which is what keeps chromatic pixels far under 5%.
- **The three workflow nodes are deliberately not colour-coded.** Planner, architect and
  coder are told apart by position and name; colour says only what state they are in. A
  screenshot of the graph still reads correctly in greyscale.
- Neither endpoint is pure: no `#FFFFFF`, no `#000000`, and no `R=G=B` value anywhere.
  Every grey in both ramps carries a trace of warmth.

## Type

Two faces differing by classification, two weights each.

- **Instrument Sans** — a grotesque with slightly narrow proportions. Carries display,
  headings, body copy and buttons. Weights 400 and 600, with nothing in between.
- **IBM Plex Mono** — carries every label, log line, file path, workspace id, numeric
  readout and code block.

Scale is ~1.25 with one deliberate jump at the display end (`--t-h1: 34px` →
`--t-display: clamp(38px, 5.6vw, 68px)`). Tracking is set optically: −0.028em on display,
+0.09em on uppercase micro labels, zero on body. Line-height moves inversely to size,
1.03 → 1.6. Body measure is capped at 68ch.

## Shape and surface

- **Radius is hierarchical, and has exactly two values**: `--r-control: 3px` on things
  you press, `--r-surface: 0` on structure. There is deliberately no third value.
- **Hairlines and space do the work shadows would.** No border-plus-shadow-plus-radius
  stacking on the same element.
- **One elevation token**, used only by dialogs — surfaces genuinely above the page.
  Light from above, colour sampled from the ink rather than neutral black.
- No glassmorphism, no backdrop blur, no decorative gradients, no gradient text.

## Layout

Structure follows content type: the overview is a document, the reference is a document
with a sticky contents rail, the studio is a three-pane instrument.

- Content sits flush left inside a centred sheet, with headings capped in `ch` so the
  right margin is consistent rather than incidental.
- Sections are separated by hairlines and generous space, not by boxes. Cards are used
  for exactly one thing: notices.
- **The studio is responsive by breakpoint, not by crushing.** Above 768px it is a fixed
  100vh instrument with three independently scrolling panes. Below 768px the panes stack
  and the body scrolls, because a 300px log panel next to a 90px editor is not a layout.

## Motion

Motion has one job: **show that something changed.**

Animated: node status transitions, the live indicator, arriving log lines, dialogs
entering and leaving, pointer and focus feedback.

**Not animated:** page sections on scroll — there is no fade-up-on-scroll anywhere in
this app, and that omission is deliberate — headings, body copy, panels, the file tree,
the editor, the toolbar, tab switching, navigation.

Durations: `--dur-fast` 110ms for state changes, `--dur-mid` 190ms for transitions,
`--dur-slow` 380ms for entering surfaces. Entering decelerates (`--ease-out`), leaving
accelerates (`--ease-in`). `prefers-reduced-motion` collapses all of it.

## Iconography

Lucide at stroke width 1.75, sized against the type it sits beside. Icons appear only
where a control needs one — run, download, key, reset, file tree, copy, menu. There are
**no icons on the overview, reference or about pages**: typographic hierarchy does that
job. No icons in tinted rounded squares above headings, ever.

## Language

Say the specific thing. "A coding agent that shows its working," not "supercharge your
workflow." Specific copy is shorter, which changes the layout, which is half the point.

---

## The sacrifice

This system spends almost nothing on colour, and it will never look exciting in a
screenshot next to something with a gradient. Emphasis is carried by weight, size,
spacing and neutral value alone, which means it depends entirely on the typography and
the spacing being right — there is no accent to hide behind. That is the trade: it should
read as credible on the tenth visit rather than striking on the first.
