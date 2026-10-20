// make-fixtures.js — generates the small, fictional PDF fixtures used by __demo and smoke.spec.js.
// Run with: node tests/make-fixtures.js   (uses only the vendored pdf-lib, no network)
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('../vendor/pdf-lib/pdf-lib.min.js');

const out = (name) => path.join(__dirname, 'fixtures', name);

async function makeDeck() {
  const doc = await PDFDocument.create();
  doc.setTitle('Product Launch Deck for Aurora Labs');
  doc.setAuthor('Aurora Labs (fictional)');
  doc.setCreator('PDF Page Organizer test fixtures');
  doc.setProducer('pdf-lib');
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const slides = [
    { title: 'Product Launch Deck', sub: 'Aurora Labs, fictional sample', color: [0.36, 0.29, 0.86] },
    { title: 'The problem', sub: 'Teams lose hours to manual setup', color: [0.05, 0.62, 0.76] },
    { title: 'Our product', sub: 'Aurora Beam, a fictional gadget', color: [0.09, 0.54, 0.30] },
    { title: 'Launch timeline', sub: 'Landscape page: Q1 build, Q2 beta, Q3 launch', color: [0.85, 0.47, 0.05], landscape: true },
    { title: 'Thank you', sub: 'Questions welcome', color: [0.78, 0.16, 0.27] },
  ];
  slides.forEach((s, i) => {
    const [w, h] = s.landscape ? [842, 595] : [595, 842];
    const page = doc.addPage([w, h]);
    page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(...s.color) });
    const num = String(i + 1);
    const size = s.landscape ? 300 : 380;
    const nw = bold.widthOfTextAtSize(num, size);
    page.drawText(num, { x: (w - nw) / 2, y: h / 2 - size * 0.3, size, font: bold, color: rgb(1, 1, 1) });
    const tw = bold.widthOfTextAtSize(s.title, 34);
    page.drawText(s.title, { x: (w - tw) / 2, y: h - 90, size: 34, font: bold, color: rgb(1, 1, 1) });
    const sw = regular.widthOfTextAtSize(s.sub, 18);
    page.drawText(s.sub, { x: (w - sw) / 2, y: 60, size: 18, font: regular, color: rgb(1, 1, 1) });
  });
  fs.writeFileSync(out('aurora-labs-launch-deck.pdf'), await doc.save());
}

// Two pages; page 1 carries an intrinsic /Rotate 90 so tests can check original + user rotation.
async function makeRotated() {
  const doc = await PDFDocument.create();
  doc.setTitle('Rotation test (fictional)');
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  ['A', 'B'].forEach((label, i) => {
    const page = doc.addPage([400, 560]);
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 560, color: rgb(0.93, 0.94, 0.97) });
    page.drawText(label, { x: 140, y: 220, size: 180, font, color: rgb(0.2, 0.2, 0.3) });
    if (i === 0) page.setRotation(degrees(90));
  });
  fs.writeFileSync(out('rotated-page.pdf'), await doc.save());
}

// A tiny PDF with a Standard security handler whose user password is not empty.
// The /U value is deliberately random, so readers ask for a password.
function makeEncrypted() {
  const hex = (n, seed) => Array.from({ length: n }, (_, i) => ((i * 37 + seed) & 255).toString(16).padStart(2, '0')).join('');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(32, 11)}> /U <${hex(32, 91)}> /P -44 >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { body += `${String(o).padStart(10, '0')} 00000 n \n`; });
  const id = hex(16, 5);
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 5 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(out('locked.pdf'), body, 'latin1');
}

(async () => {
  await makeDeck();
  await makeRotated();
  makeEncrypted();
  console.log('fixtures written');
})();
