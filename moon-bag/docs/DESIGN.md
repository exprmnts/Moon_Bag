# Moonbag website — design and mechanics

The site is the Moonbag pitch deck rendered as a website: seven full-screen slides plus one hidden interlude, black type on white, one serif face, animated in with `motion`. This document records the decisions so they survive the next redesign conversation.

## 1. Palette

Black `#000` on white `#fff`. Nothing else. `tailwind.config.js` removes the default palette so a grey cannot slip in through a utility class. Rules, borders, the progress line and the chart are 1px or 2px solid black. Hover states invert: black fill, white text.

## 2. Type

**Newsreader** (Google Fonts, loaded through `next/font/google` with the italic style and the optical-size axis; automatic fallback tuning is off because Next has no metric table for it). **Geist Mono** (local, `app/fonts/`) for chrome only.

The scale lives in `app/globals.css` as component classes so sizes are changed in one place:

| Class | Use | Size |
| --- | --- | --- |
| `.t-hero-it` | Homepage headline. Italic, weight 300. | phones `clamp(3rem, 16vw, 4.6rem)`, ≥640px `clamp(2.8rem, 8.4vw, 7.8rem)` |
| `.t-hero-cta` | Homepage CTA line | phones `clamp(1rem, 4.2vw, 1.15rem)`, ≥640px `clamp(1.15rem, 1.9vw, 1.75rem)` |
| `.t-xl` | Punchlines ("Nah we won't do that to you") | `clamp(2rem, 5vw, 4.6rem)` |
| `.t-lg` | Lead line of a slide | `clamp(1.5rem, 3.2vw, 2.9rem)` |
| `.t-md` | Body lines, list items, FAQ questions | `clamp(1.25rem, 2.3vw, 2.05rem)` |
| `.t-sm` | FAQ answers | `clamp(1.05rem, 1.7vw, 1.45rem)` |
| `.t-label` | Mono kickers: "How It Works", "FAQ", "Revenue", the counter | `clamp(0.65rem, 0.9vw, 0.8rem)`, letter-spaced, uppercase |

Headline-to-CTA ratio on the homepage is about 4.5:1 on desktop and 4:1 on phones. Keep that hierarchy if sizes change.

## 3. The homepage (slide 1)

Chosen from the "homepage variations" study as variation 02:

- "Did you leave / a moonbag?" centred, italic light, two lines at every width, with its own ordinary question mark. No decorative giant mark.
- Underneath, centred, `Click here for paperhand calculator →` and the **pill button** (`PillButton.js`): hairline outline, fully rounded, fills black on hover, presses to 95% on click. On phones the line shortens to `Paperhand calculator →` so the headline stays dominant.
- The button opens the hidden interlude (slide 2). Nothing else reaches it.

## 4. The other slides

All single-column slides (4 to 8) share one column: `mx-auto max-w-3xl`, left-aligned, lead line in `.t-lg`, body in `.t-md`, `space-y-4 sm:space-y-5` between lines, a mono `.t-label` kicker where the deck had a heading. Slide 3 is a two-column grid: the self-drawing chart on the left, text on the right.

| # | id | Content | Notes |
| --- | --- | --- | --- |
| 1 | `hero` | Did you leave a moonbag? + CTA | see above |
| – | `joke` | Nah we won't do that to you… | `hidden: true`; counter fades out while it shows |
| 2 | `research` | Chart + "Research shows 90% trenchers…" | chart draws on enter, "made it up" fades in last |
| 3 | `definition` | What a moon bag is, "Don't be that guy." | copy tightened with owner's approval |
| 4 | `token` | $MOON on Pons, Revenue | "Revenue" is a `.t-label` |
| 5 | `how` | How It Works, six numbered steps | numbers in mono, no rules |
| 6 | `promise` | Moonbag Bot will ensure you always leave the moonbag. | |
| 7 | `faq` | Five questions, numbered like How It Works | accordion; rows never turn the page |

The counter reads `01 / 07`: it counts visible slides only.

## 5. Motion

`app/components/variants.js`:

- `stageFor(getDir)` — the slide-level transition. Enter from `y: +90` when going forward, `-90` when going back; exit the opposite way; opacity with it. Direction is read from a ref at animation time so an exiting slide always uses the latest direction.
- `line` — every readable line: opacity 0, `y: 18`, 6px blur → visible. The stage staggers children by 60ms.
- `group(stagger)` — nested orchestrator for word-by-word reveals (`Words` in `slides.js`).

Slides are swapped with `AnimatePresence mode="popLayout"` so the outgoing and incoming slides move at the same time. The chart's path, dots and caption use `hidden`/`show` variants so they draw only when their slide shows.

## 6. Navigation (`Deck.js`)

The page never scrolls; input turns pages.

- **Wheel / trackpad.** The first 12px of intent turns the page. Input is ignored for 700ms while the turn plays, and after that the momentum tail is still ignored: a new gesture is recognised by a 150ms pause, by a jump in delta (acceleration), or by a discrete mouse notch (≥100px). One swipe is one page.
- **Click or tap anywhere.** Next page, unless the target is a button, a link, or inside `[data-no-advance]` (the FAQ list).
- **Swipe.** 30px of finger travel; up is next, down is back.
- **Keys.** Arrows, Space, PageUp/Down, Home, End.
- **Hidden slides.** `step()` walks past any slide with `hidden: true`. `go()` can still reach it directly (the hero button, the `#2` hash).
- **Deep links.** `#3` opens slide 3; the hash follows navigation. Hash numbers are raw positions including the hidden slide.

## 7. Fit to screen

`Fit` in `Deck.js` measures a slide's natural height against the space between the header and the footer chrome and scales it down (never up) with `transform: scale()`, keeping layout width. This is why a turn is never blocked by a tall slide and why a laptop with browser chrome at 540px still shows everything. A `ResizeObserver` re-fits when content changes (opening an FAQ answer).

## 8. Chrome

- Counter top-right, mono, digits roll on change.
- 2px progress line along the top, width = visible slide index / 7, spring-eased.
- "scroll ↓" cue bottom-centre on slide 1 only, arrow bobbing.
- Pencil cursor (`Cursor.js`) on fine pointers: follows with a tight spring, tilts over anything clickable, presses in on click. Touch devices keep the native cursor.

## 9. Responsiveness

Type is `clamp()` everywhere; the hero has an explicit phone tier under 640px. Tested widths: 360, 390, 430 (phones), 768 (tablet), 1000×540 (laptop with chrome) and 1440×900. The check is: no horizontal overflow, every slide fits without `Fit` having to scale below about 0.9, and one gesture turns one page.

## 10. Design history (for context, not in the repo)

The `design-experiments/` folder, git-ignored, holds the studies that led here: five handwriting/paper themes (rejected), ten homepage layouts in Newsreader (variation 02 chosen), fifteen giant-question-mark mixes and three placements (tried on the live site, then reverted in favour of 02). If a future change wants the big question mark back, placement 02 of `moonbag-question-placement.html` is the version that was liked.
