// worker.js — rewrites the PDF with pdf-lib off the main thread (classic worker).
// Messages in:  { id, type: 'inspect', bytes }            -> { id, type: 'inspected', pageCount, rotations }
//               { id, type: 'build', bytes, pages }       -> progress..., { id, type: 'done', data, pageCount }
//               pages = [{ src: originalIndex, rot: extraDegrees }] in the new order (deleted pages left out)
importScripts('./vendor/pdf-lib/pdf-lib.min.js');

const norm = (deg) => ((Math.round(deg / 90) * 90) % 360 + 360) % 360;

function describe(err) {
  const name = (err && (err.name || (err.constructor && err.constructor.name))) || 'Error';
  const message = (err && err.message) || String(err);
  const encrypted = name === 'EncryptedPDFError' || /encrypt/i.test(message);
  return { name, message, encrypted };
}

async function load(bytes) {
  return PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
}

self.onmessage = async (event) => {
  const { id, type, bytes } = event.data;
  const progress = (value, label) => self.postMessage({ id, type: 'progress', value, label });
  try {
    if (type === 'inspect') {
      const doc = await load(bytes);
      const rotations = doc.getPages().map((p) => norm(p.getRotation().angle));
      self.postMessage({ id, type: 'inspected', pageCount: doc.getPageCount(), rotations });
      return;
    }
    if (type === 'build') {
      const { pages } = event.data;
      progress(0.05, 'Reading the original PDF');
      const src = await load(bytes);
      const out = await PDFLib.PDFDocument.create();
      const title = src.getTitle();
      if (title) out.setTitle(title);
      const author = src.getAuthor();
      if (author) out.setAuthor(author);
      out.setProducer('PDF Page Organizer (pdf-lib)');
      progress(0.25, 'Copying pages');
      const copied = await out.copyPages(src, pages.map((p) => p.src));
      copied.forEach((page, i) => {
        const original = src.getPage(pages[i].src).getRotation().angle;
        page.setRotation(PDFLib.degrees(norm(original + pages[i].rot)));
        out.addPage(page);
        if (i % 10 === 9) progress(0.25 + 0.5 * ((i + 1) / copied.length), `Placing page ${i + 1} of ${copied.length}`);
      });
      progress(0.8, 'Writing the new file');
      const data = await out.save();
      self.postMessage({ id, type: 'done', data, pageCount: out.getPageCount() }, [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: describe(err) });
  }
};
