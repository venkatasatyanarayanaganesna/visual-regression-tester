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
// - FAIL_PERCENT_THRESHOLD is the overall % of the image that must differ
//   before we call it a real regression, so a handful of stray pixels
//   (font hinting, sub-pixel rendering) don't fail the whole run.
const PIXELMATCH_OPTIONS = { threshold: 0.15, includeAA: false };
const FAIL_PERCENT_THRESHOLD = 0.1; // fail if more than 0.1% of pixels differ

function loadPages() {
  if (!fs.existsSync(PAGES_FILE)) {
    throw new Error(`pages.json not found at ${PAGES_FILE}`);
  }
  return JSON.parse(fs.readFileSync(PAGES_FILE, 'utf-8'));
}

async function captureScreenshot(browser, url, outPath) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: outPath, fullPage: true });
  await page.close();
}

// ---------- Baseline command ----------

async function runBaseline() {
  const pages = loadPages();
  fs.mkdirSync(BASELINE_DIR, { recursive: true });

  const browser = await chromium.launch();
  console.log(`Capturing ${pages.length} baseline screenshot(s)...\n`);

  for (const { name, url } of pages) {
    const outPath = path.join(BASELINE_DIR, `${name}.png`);
    try {
      await captureScreenshot(browser, url, outPath);
      console.log(`  ✓ ${name} -> baselines/${name}.png`);
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

function diffImages(baselinePath, currentPath, diffPath) {
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
  const status = diffPercent > FAIL_PERCENT_THRESHOLD ? 'fail' : 'pass';

  return { status, diffPercent, diffPixels, totalPixels };
}

async function runCheck() {
  const pages = loadPages();
  fs.mkdirSync(CURRENT_DIR, { recursive: true });
  fs.mkdirSync(DIFF_DIR, { recursive: true });

  const browser = await chromium.launch();
  console.log(`Capturing ${pages.length} current screenshot(s) and comparing to baseline...\n`);

  const results = [];

  for (const { name, url } of pages) {
    const baselinePath = path.join(BASELINE_DIR, `${name}.png`);
    const currentPath = path.join(CURRENT_DIR, `${name}.png`);
    const diffPath = path.join(DIFF_DIR, `${name}.png`);

    if (!fs.existsSync(baselinePath)) {
      console.log(`  ? ${name}: no baseline found — run "baseline" first. Skipping.`);
      results.push({ name, url, status: 'no-baseline' });
      continue;
    }

    try {
      await captureScreenshot(browser, url, currentPath);
      const result = diffImages(baselinePath, currentPath, diffPath);

      if (result.status === 'pass') {
        console.log(`  ✓ ${name}: PASS (${result.diffPercent.toFixed(3)}% diff, within threshold)`);
      } else if (result.status === 'fail') {
        console.log(`  ✗ ${name}: FAIL (${result.diffPercent.toFixed(3)}% diff — see diffs/${name}.png)`);
      } else if (result.status === 'size-mismatch') {
        console.log(`  ✗ ${name}: FAIL — ${result.message}`);
      }

      results.push({ name, url, ...result });
    } catch (err) {
      console.error(`  ✗ ${name}: error — ${err.message}`);
      results.push({ name, url, status: 'error', message: err.message });
    }
  }

  await browser.close();
  writeHtmlReport(results);

  const failed = results.filter((r) => r.status === 'fail' || r.status === 'size-mismatch' || r.status === 'error');
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

      const images =
        r.status === 'fail'
          ? `
        <div style="display:flex;gap:8px;margin-top:8px">
          <div><p>Baseline</p><img src="baselines/${r.name}.png" width="300"></div>
          <div><p>Current</p><img src="current/${r.name}.png" width="300"></div>
          <div><p>Diff</p><img src="diffs/${r.name}.png" width="300"></div>
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
