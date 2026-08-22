# Visual Regression Tester

Catches UI bugs that functional tests miss — broken layouts,
misaligned elements, unintended style changes — by comparing
screenshots pixel-by-pixel against a known-good baseline, with
"smart" diffing that filters out anti-aliasing and rendering noise
instead of flagging every 1-pixel wobble.

## Why

A functional test can confirm a button is clickable while the button
itself is visually broken — wrong color, wrong position, overlapping
text. Visual regression testing catches the class of bugs that "does
it work" tests structurally cannot: does it *look* right.

## How the "smart" diffing works

Naive pixel diffing is noisy — the same page rendered twice can differ
by hundreds of pixels just from anti-aliasing and sub-pixel font
rendering, with zero real change. This tool filters that out two ways:

1. **`includeAA: false`** (pixelmatch option) — ignores anti-aliased
   edge pixels entirely, the single biggest source of false positives.
2. **Overall diff-percentage threshold** — a page only fails if more
   than **0.1%** of its total pixels differ, not on any single pixel
   mismatch. This threshold is tunable in `visualDiff.js`
   (`FAIL_PERCENT_THRESHOLD`).

Genuine regressions — a shifted layout, a missing element, a broken
stylesheet — produce diffs far above this threshold and get flagged
clearly, with the differing region highlighted in red in the diff
image.

## Setup

```bash
npm install
npx playwright install chromium
```

## Configure which pages to test

Edit `pages.json`:

```json
[
  { "name": "homepage", "url": "https://example.com/" },
  { "name": "pricing", "url": "https://example.com/pricing" }
]
```

## Usage

**1. Capture your baseline** (do this once, when the UI is in a known-good state):

```bash
npm run baseline
```

Saves reference screenshots to `baselines/`. Commit this folder to
git — it's your source of truth for "what the UI should look like."

**2. After making UI changes, check for regressions:**

```bash
npm run check
```

This captures fresh screenshots, diffs each against its baseline, and:
- Prints a pass/fail summary per page to the console
- Generates `report.html` — open it in a browser to visually review
  any failures side-by-side (baseline / current / diff image)
- Exits with a non-zero code if any page fails, so this can gate a
  CI pipeline the same way a normal test suite would

**3. When a change is intentional**, re-run `npm run baseline` to
update the reference screenshots to the new (correct) UI.

## Example output

```
Capturing 2 current screenshot(s) and comparing to baseline...

  ✓ playwright-homepage: PASS (0.012% diff, within threshold)
  ✗ playwright-docs: FAIL (2.847% diff — see diffs/playwright-docs.png)

1/2 passed. Report: report.html
1 page(s) show visual regressions — open the report to review.
```
