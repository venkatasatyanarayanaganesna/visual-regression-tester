const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');

const BASELINE_DIR = path.join(__dirname, 'baselines');
const CURRENT_DIR = path.join(__dirname, 'current');
const DIFF_DIR = path.join(__dirname, 'diffs');
const REPORT_FILE = path.join(__dirname, 'report.html');
const PAGES_FILE = path.join(__dirname, 'pages.json');

// "Smart" thresholds — this is what separates useful diffing from noise:
// - pixelmatch's own `threshold` (0-1) controls per-pixel color sensitivity;
//   higher = more tolerant of minor color/anti-aliasing differences.
// - includeAA: false tells pixelmatch to ignore anti-aliased edge pixels
//   entirely, which are the #1 source of false-positive "differences"
//   between two screenshots of an identical page.
// - FAIL_PERCENT_THRESHOLD is the default % of the image that must differ
//   before we call it a real regression. A page in pages.json can override
//   it with its own "failPercent" value.
const PIXELMATCH_OPTIONS = { threshold: 0.15, includeAA: false };
const FAIL_PERCENT_THRESHOLD = 0.1; // fail if more than 0.1% of pixels differ

// Stable-capture settings: keep taking screenshots until two in a row are
// byte-identical (the page has stopped changing), up to MAX_STABLE_ATTEMPTS.
const MAX_STABLE_ATTEMPTS = 5;
const STABLE_DELAY_MS = 400;

function loadPages() {
  if (!fs.existsSync(PAGES_FILE)) {
    throw new Error(`pages.json not found at ${PAGES_FILE}`);
  }
  return JSON.parse(fs.readFileSync(PAGES_FILE, 'utf-8'));
}

// ---------- Capture helpers ----------

// Scroll to the bottom in steps so lazy-loaded images/sections get requested,
// then return to the top. Capped so infinite-scroll pages can't loop forever.
async function scrollThroughPage(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const step = window.innerHeight;
      let y = 0;
      let steps = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        steps += 1;
        if (y >= document.documentElement.scrollHeight || steps >= 40) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
    window.scrollTo(0, 0);
  });
}

// Wait for every image and web font to finish loading (5s cap per image).
async function waitForAssets(page) {
  await page.evaluate(async () => {
    const imgs = Array.from(document.images);
    await Promise.all(
      imgs.map((img) =>
        img.complete
          ? null
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
              setTimeout(resolve, 5000);
            })
      )
    );
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });
}

// pageConfig may contain:
//   mask: ["css selector", ...]  elements hidden behind a solid box in the screenshot
async function captureScreenshot(browser, pageConfig, outPath) {
  const { url, mask = [] } = pageConfig;
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await scrollThroughPage(page);
    await waitForAssets(page);
    await page.waitForTimeout(500); // let late rendering settle

    const maskLocators = mask.map((selector) => page.locator(selector));

    let previous = null;
    let current = null;
    let stable = false;

    for (let attempt = 0; attempt < MAX_STABLE_ATTEMPTS; attempt++) {
      current = await page.screenshot({
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        mask: maskLocators,
      });
      if (previous && previous.equals(current)) {
        stable = true;
        break;
      }
      previous = current;
      await page.waitForTimeout(STABLE_DELAY_MS);
    }

    fs.writeFileSync(outPath, current);
    return { stable };
  } finally {
    await page.close();
  }
}

// ---------- Baseline command ----------

async function runBaseline() {
  const pages = loadPages();
  fs.mkdirSync(BASELINE_DIR, { recursive: true });

  const browser = await chromium.launch();
  console.log(`Capturing ${pages.length} baseline screenshot(s)...\n`);

  for (const pageConfig of pages) {
    const { name } = pageConfig;
    const outPath = path.join(BASELINE_DIR, `${name}.png`);
    try {
      const { stable } = await captureScreenshot(browser, pageConfig, outPath);
      const note = stable ? '' : '  (warning: page never fully settled — consider adding a "mask")';
      console.log(`  ✓ ${name} -> baselines/${name}.png${note}`);
    } catch (err) {
      console.error(`  ✗ ${name} failed: ${err.message}`);
    }
  }

  await browser.close();
  console.log(`\nBaseline capture complete. Re-run with "check" after making UI changes.`);
}

// ---------- Check command ----------

function loadPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function diffImages(baselinePath, currentPath, diffPath, failPercent) {
  const baseline = loadPng(baselinePath);
  const current = loadPng(currentPath);

  // If dimensions differ (e.g. content length changed the full-page height),
  // we can't pixel-diff directly — report it as a structural change instead
  // of crashing or silently comparing a cropped mismatch.
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      status: 'size-mismatch',
      diffPercent: null,
      message: `Dimensions changed: baseline ${baseline.width}x${baseline.height} -> current ${current.width}x${current.height}`,
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    PIXELMATCH_OPTIONS
  );

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  const diffPercent = (diffPixels / totalPixels) * 100;
  const status = diffPercent > failPercent ? 'fail' : 'pass';

  return { status, diffPercent, diffPixels, totalPixels };
}

async function runCheck() {
  const pages = loadPages();
  fs.mkdirSync(CURRENT_DIR, { recursive: true });
  fs.mkdirSync(DIFF_DIR, { recursive: true });

  const browser = await chromium.launch();
  console.log(`Capturing ${pages.length} current screenshot(s) and comparing to baseline...\n`);

  const results = [];

  for (const pageConfig of pages) {
    const { name, url } = pageConfig;
    const failPercent =
      typeof pageConfig.failPercent === 'number' ? pageConfig.failPercent : FAIL_PERCENT_THRESHOLD;
    const baselinePath = path.join(BASELINE_DIR, `${name}.png`);
    const currentPath = path.join(CURRENT_DIR, `${name}.png`);
    const diffPath = path.join(DIFF_DIR, `${name}.png`);

    if (!fs.existsSync(baselinePath)) {
      console.log(`  ? ${name}: no baseline found — run "baseline" first. Skipping.`);
      results.push({ name, url, status: 'no-baseline' });
      continue;
    }

    try {
      const { stable } = await captureScreenshot(browser, pageConfig, currentPath);
      const result = diffImages(baselinePath, currentPath, diffPath, failPercent);
      const note = stable ? '' : ' [page did not fully settle]';

      if (result.status === 'pass') {
        console.log(`  ✓ ${name}: PASS (${result.diffPercent.toFixed(3)}% diff, within threshold)${note}`);
      } else if (result.status === 'fail') {
        console.log(`  ✗ ${name}: FAIL (${result.diffPercent.toFixed(3)}% diff — see diffs/${name}.png)${note}`);
      } else if (result.status === 'size-mismatch') {
        console.log(`  ✗ ${name}: FAIL — ${result.message}${note}`);
      }

      results.push({ name, url, ...result });
    } catch (err) {
      console.error(`  ✗ ${name}: error — ${err.message}`);
      results.push({ name, url, status: 'error', message: err.message });
    }
  }

  await browser.close();
  writeHtmlReport(results);

  const failed = results.filter(
    (r) => r.status === 'fail' || r.status === 'size-mismatch' || r.status === 'error'
  );
  console.log(`\n${results.length - failed.length}/${results.length} passed. Report: ${REPORT_FILE}`);
  if (failed.length > 0) {
    console.log(`${failed.length} page(s) show visual regressions — open the report to review.`);
    process.exitCode = 1;
  }
}

// ---------- HTML report ----------

function writeHtmlReport(results) {
  const rows = results
    .map((r) => {
      const badge =
        r.status === 'pass'
          ? '<span style="color:#0a0;font-weight:bold">PASS</span>'
          : r.status === 'no-baseline'
          ? '<span style="color:#999;font-weight:bold">NO BASELINE</span>'
          : '<span style="color:#c00;font-weight:bold">FAIL</span>';

      const diffInfo =
        r.diffPercent != null
          ? `${r.diffPercent.toFixed(3)}% pixels differ`
          : r.message || '';

      const showImages = r.status === 'fail' || r.status === 'size-mismatch';
      const images = showImages
        ? `
        <div style="display:flex;gap:8px;margin-top:8px">
          <div><p>Baseline</p><img src="baselines/${r.name}.png" width="300"></div>
          <div><p>Current</p><img src="current/${r.name}.png" width="300"></div>
          ${
            r.status === 'fail'
              ? `<div><p>Diff</p><img src="diffs/${r.name}.png" width="300"></div>`
              : ''
          }
        </div>`
        : '';

      return `
        <tr>
          <td>${r.name}</td>
          <td>${badge}</td>
          <td>${diffInfo}</td>
        </tr>
        ${images ? `<tr><td colspan="3">${images}</td></tr>` : ''}
      `;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Visual Regression Report</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #fafafa; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    td, th { border: 1px solid #ddd; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #f0f0f0; }
    img { border: 1px solid #ccc; }
  </style>
</head>
<body>
  <h1>Visual Regression Report</h1>
  <p>Generated ${new Date().toLocaleString()}</p>
  <table>
    <tr><th>Page</th><th>Status</th><th>Diff Detail</th></tr>
    ${rows}
  </table>
</body>
</html>`;

  fs.writeFileSync(REPORT_FILE, html);
}

// ---------- CLI entry point ----------

async function main() {
  const command = process.argv[2];

  if (command === 'baseline') {
    await runBaseline();
  } else if (command === 'check') {
    await runCheck();
  } else {
    console.log(
      'Usage:\n' +
      '  node visualDiff.js baseline   # capture reference screenshots for all pages in pages.json\n' +
      '  node visualDiff.js check      # capture new screenshots and diff against baseline'
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}