// smoke.spec.js — PDF Page Organizer: core actions on fictional fixtures (regenerate with `node tests/make-fixtures.js`).
// Saved PDFs are inspected inside the page with the vendored pdf-lib (rotation, page count) and pdf.js (page text).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const DECK = 'aurora-labs-launch-deck.pdf';
const OUT = 'aurora-labs-launch-deck_organized.pdf';

async function open(page, name = DECK) {
  await page.goto('./');
  await page.setInputFiles('#file-input', fixture(name));
}

async function openDeck(page) {
  await open(page);
  await expect(page.locator('#page-grid .page-card')).toHaveCount(5);
}

const card = (page, n) => page.locator(`#page-grid .page-card:has(.page-card__num:text-is("${n}"))`);

async function saveAndDownload(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  expect(download.suggestedFilename()).toBe(OUT);
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.length).toBeGreaterThan(500);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await expect(page.locator('#results .result--saved')).toContainText(OUT);
  return bytes;
}

// Returns [{ rotation, text }] for every page of the PDF.
async function inspect(page, bytes) {
  return page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await window.PDFLib.PDFDocument.load(data.slice());
    const pdfjs = await import('./vendor/pdfjs-dist/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs-dist/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data }).promise;
    const out = [];
    for (let i = 0; i < doc.getPageCount(); i++) {
      const p = await pdf.getPage(i + 1);
      const tc = await p.getTextContent();
      out.push({ rotation: doc.getPage(i).getRotation().angle, text: tc.items.map((t) => t.str).join(' ') });
    }
    return out;
  }, bytes.toString('base64'));
}

// The big page number drawn on each deck page tells us which original page ended up where.
const numbers = (pages) => pages.map((p) => Number(p.text.match(/\b([1-5])\b/)[1]));

test.describe('PDF Page Organizer', () => {
  test('loading the bundled sample shows one thumbnail per page', async ({ page }) => {
    await openDeck(page);
    await expect(page.locator('#page-grid .page-card.is-rendered')).toHaveCount(5);
    await expect(page.locator('#file-name')).toHaveText(DECK);
    await expect(page.locator('#summary')).toContainText('Keeping 5 of 5 pages · 0 removed');
    await expect(page.locator('#dropzone')).toBeHidden();
    // Landscape and portrait pages share the same card box.
    const sizes = await page.locator('.page-card__thumb').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(sizes).size).toBe(1);
    const canvases = await page.locator('.page-card canvas').evaluateAll((els) => els.map((c) => [c.width, c.height]));
    expect(canvases[3][0]).toBeGreaterThan(canvases[3][1]); // page 4 is landscape
    expect(canvases[0][1]).toBeGreaterThan(canvases[0][0]);
  });

  test('rotating page 2 by 90 degrees and saving yields a PDF whose page 2 has rotation 90', async ({ page }) => {
    await openDeck(page);
    await page.getByRole('button', { name: 'Rotate page 2 right' }).click();
    await expect(card(page, 2).locator('.page-card__rot')).toHaveText('90°');
    const pages = await inspect(page, await saveAndDownload(page));
    expect(pages.map((p) => p.rotation)).toEqual([0, 90, 0, 0, 0]);
    expect(numbers(pages)).toEqual([1, 2, 3, 4, 5]);
  });

  test('deleting page 1 reduces the saved page count by one', async ({ page }) => {
    await openDeck(page);
    await page.getByRole('button', { name: 'Delete page 1' }).click();
    await expect(card(page, 1)).toHaveClass(/is-deleted/);
    await expect(page.getByRole('button', { name: 'Restore page 1' })).toBeVisible();
    await expect(page.locator('#summary')).toContainText('Keeping 4 of 5 pages · 1 removed');
    const pages = await inspect(page, await saveAndDownload(page));
    expect(pages).toHaveLength(4);
    expect(numbers(pages)).toEqual([2, 3, 4, 5]);
    await expect(page.locator('#results .result--saved')).toContainText('4 pages kept, 1 removed');
  });

  test('moving the last page to first changes the saved order', async ({ page }) => {
    await openDeck(page);
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Move page 5 earlier' }).click();
    await expect(page.locator('#page-grid .page-card').first()).toHaveAttribute('aria-label', /^Page 5, position 1 of 5/);
    await expect(page.getByRole('button', { name: 'Move page 5 earlier' })).toBeDisabled();
    const pages = await inspect(page, await saveAndDownload(page));
    expect(numbers(pages)).toEqual([5, 1, 2, 3, 4]);
  });

  test('dragging a card with the pointer reorders pages', async ({ page }) => {
    await openDeck(page);
    const from = await card(page, 5).locator('.page-card__thumb').boundingBox();
    const to = await card(page, 1).locator('.page-card__thumb').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 8 });
    await expect(card(page, 1)).toHaveClass(/drop-before/);
    await page.mouse.up();
    await expect(page.locator('#page-grid .page-card .page-card__num')).toHaveText(['5', '1', '2', '3', '4']);
    const pages = await inspect(page, await saveAndDownload(page));
    expect(numbers(pages)).toEqual([5, 1, 2, 3, 4]);
  });

  test('keyboard: arrows move focus, R rotates, Delete removes, Alt+arrow moves, Ctrl+Z undoes', async ({ page }) => {
    await openDeck(page);
    await card(page, 1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(card(page, 2)).toBeFocused();
    await page.keyboard.press('r');
    await expect(card(page, 2).locator('.page-card__rot')).toHaveText('90°');
    await page.keyboard.press('Shift+R');
    await expect(card(page, 2).locator('.page-card__rot')).toBeHidden();
    await page.keyboard.press('Delete');
    await expect(card(page, 2)).toHaveClass(/is-deleted/);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('#page-grid .page-card .page-card__num')).toHaveText(['2', '1', '3', '4', '5']);
    await expect(card(page, 2)).toBeFocused();
    await page.keyboard.press('Control+z');
    await expect(page.locator('#page-grid .page-card .page-card__num')).toHaveText(['1', '2', '3', '4', '5']);
    await page.click('#undo');
    await expect(card(page, 2)).not.toHaveClass(/is-deleted/);
    await page.click('#undo');
    await page.click('#undo');
    await expect(page.locator('#undo')).toBeDisabled();
  });

  test('select all, rotate selected and delete selected; saving with every page deleted is prevented', async ({ page }) => {
    await openDeck(page);
    await page.getByLabel('Select page 3').check();
    await page.getByLabel('Select page 4').check();
    await page.click('#rotate-selected');
    await expect(card(page, 3).locator('.page-card__rot')).toHaveText('90°');
    await expect(card(page, 4).locator('.page-card__rot')).toHaveText('90°');
    await page.click('#select-all');
    await expect(page.locator('#select-all')).toHaveText('Clear selection');
    await page.click('#delete-selected');
    await expect(page.locator('#page-grid .page-card.is-deleted')).toHaveCount(5);
    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.click('#save');
    await expect(page.locator('#results .alert--error')).toContainText('Restore at least one page');
    await page.waitForTimeout(300);
    expect(downloaded).toBe(false);
    await page.click('#undo');
    const pages = await inspect(page, await saveAndDownload(page));
    expect(pages.map((p) => p.rotation)).toEqual([0, 0, 90, 90, 0]);
  });

  test('a page with its own rotation keeps it and adds the user rotation', async ({ page }) => {
    await open(page, 'rotated-page.pdf');
    await expect(page.locator('#page-grid .page-card.is-rendered')).toHaveCount(2);
    const [c1] = await page.locator('.page-card canvas').evaluateAll((els) => els.map((c) => [c.width, c.height]));
    expect(c1[0]).toBeGreaterThan(c1[1]); // portrait page with /Rotate 90 shows as landscape
    await page.getByRole('button', { name: 'Rotate page 1 right' }).click();
    await page.getByRole('button', { name: 'Rotate page 2 left' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    expect(download.suggestedFilename()).toBe('rotated-page_organized.pdf');
    const pages = await inspect(page, fs.readFileSync(await download.path()));
    expect(pages.map((p) => p.rotation)).toEqual([180, 270]);
  });

  test('password protected PDFs show a not supported message', async ({ page }) => {
    await open(page, 'locked.pdf');
    await expect(page.locator('#results .alert--error')).toContainText(/password protected or encrypted/);
    await expect(page.locator('#organizer')).toBeHidden();
    await expect(page.locator('#dropzone')).toBeVisible();
  });

  test('the toolbar is live right after loading, and saving without edits keeps every page', async ({ page }) => {
    await openDeck(page);
    await expect(page.locator('#save')).toBeEnabled();
    await expect(page.locator('#select-all')).toBeEnabled();
    await expect(page.locator('#undo')).toBeDisabled();
    await page.click('#select-all');
    await expect(page.locator('#page-grid .page-card.is-selected')).toHaveCount(5);
    await expect(page.locator('#rotate-selected')).toBeEnabled();
    await page.click('#select-all');
    await expect(page.locator('#page-grid .page-card.is-selected')).toHaveCount(0);
    const pages = await inspect(page, await saveAndDownload(page));
    expect(numbers(pages)).toEqual([1, 2, 3, 4, 5]);
    expect(pages.map((p) => p.rotation)).toEqual([0, 0, 0, 0, 0]);
  });

  test('a PDF opens normally after a file that failed to load', async ({ page }) => {
    await open(page, 'locked.pdf');
    await expect(page.locator('#results .alert--error')).toContainText(/password protected/);
    await page.setInputFiles('#file-input', fixture(DECK));
    await expect(page.locator('#page-grid .page-card')).toHaveCount(5);
    await expect(page.locator('#results .alert--error')).toHaveCount(0);
    await expect(page.locator('#save')).toBeEnabled();
    // Damaged file, then a good one.
    await page.click('#open-another');
    await page.setInputFiles('#file-input', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 but nothing else') });
    await expect(page.locator('#results .alert--error')).toContainText('could not be read as a PDF');
    await page.setInputFiles('#file-input', fixture(DECK));
    await expect(page.locator('#page-grid .page-card')).toHaveCount(5);
    await expect(page.locator('#results .alert--error')).toHaveCount(0);
    await saveAndDownload(page);
  });

  test('wrong file types are rejected, also when mixed with a PDF', async ({ page }) => {
    await page.goto('./');
    await page.setInputFiles('#file-input', fixture('sample.png'));
    await expect(page.locator('#results .alert--error')).toContainText('“sample.png” is not a PDF');
    await expect(page.locator('#organizer')).toBeHidden();
    // Mixed drop: the PDF opens and the image is reported.
    await page.evaluate(async () => {
      const get = async (n, type) => new File([await (await fetch(`./tests/fixtures/${n}`)).blob()], n, { type });
      const dt = new DataTransfer();
      dt.items.add(await get('sample.png', 'image/png'));
      dt.items.add(await get('aurora-labs-launch-deck.pdf', 'application/pdf'));
      document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#page-grid .page-card')).toHaveCount(5);
    await expect(page.locator('#results .alert--error')).toContainText('“sample.png” is not a PDF');
    // A file named .pdf that is not a PDF.
    await page.click('#open-another');
    await page.setInputFiles('#file-input', { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('just some text, not a pdf') });
    await expect(page.locator('#results .alert--error')).toContainText('could not be read as a PDF');
  });

  test('layout works at 390px wide with a two column thumbnail grid', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDeck(page);
    const cols = await page.locator('#page-grid').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    expect(cols).toBe(2);
    const first = await card(page, 1).boundingBox();
    const second = await card(page, 2).boundingBox();
    expect(Math.round(second.y)).toBe(Math.round(first.y));
    await expect(page.getByRole('button', { name: 'Move page 3 earlier' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete page 3' }).click();
    await saveAndDownload(page);
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.win + 1);
  });

  test('__demo shows a realistic finished state', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => window.__demo());
    await expect(page.locator('#page-grid .page-card')).toHaveCount(5);
    await expect(page.locator('#page-grid .page-card.is-deleted')).toHaveCount(1);
    await expect(page.locator('#results .result--saved')).toContainText(OUT);
    await expect(page.locator('#results .result--saved')).toContainText('4 pages kept, 1 removed');
  });
});
