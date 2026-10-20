# PDF Page Organizer — specification

**Tagline:** Reorder, rotate and delete PDF pages visually in your browser and save the result, with no upload.

**Category:** PDF

**Free alternative to:** Sejda and iLovePDF Organize PDF (free tier limits pages and tasks per hour, uploads documents, ads and upsells)

**Search phrases:** reorder pdf pages, rotate pdf pages, delete pages from pdf, rearrange pdf pages, organize pdf, remove pages from pdf online

**Allowed libraries:** pdf-lib, pdfjs-dist

**Published at:** https://turhe123.github.io/pdf-page-organizer/

## Acceptance checks (each must have a test)

- loading the bundled sample shows one thumbnail per page
- rotating page 2 by 90 degrees and saving yields a PDF whose page 2 has rotation 90
- deleting page 1 reduces the saved page count by one
- moving the last page to first changes the saved order
- layout works at 390px wide with a two column thumbnail grid

## Spec

Searches like rotate pdf pages, delete pages from pdf and rearrange pdf pages are huge. The incumbents either upload the file, limit free runs per hour, cap page count, or hide the save step behind an account. Reviews of iLovePDF and Sejda mention exactly those limits, so a local tool that never uploads is a clear win.

Our version does one job: show every page as a thumbnail and let the user rotate, delete and reorder pages, then save a new PDF. It does not edit content, add text or merge files.

UI: a drop zone accepts one PDF. After loading, a responsive grid of thumbnail cards appears, each with a page number badge and three small buttons: rotate left, rotate right and delete. Cards can be dragged to reorder using pointer events, and also have move earlier and move later buttons for touch and keyboard. A toolbar offers select all, rotate selected, delete selected and an undo button that steps back through actions. Deleted pages are shown dimmed with a restore button until saving. A Save PDF button downloads name_organized.pdf and a summary line states pages kept and removed. Empty state explains the tool and privacy. Error state for unreadable or encrypted files. Keyboard: arrow keys move focus between cards, R rotates, Delete removes, and Alt plus arrows moves the card.

Technical approach: pdfjs-dist renders each page at a small scale to a canvas for the thumbnail, lazily using IntersectionObserver so a 200 page file stays responsive, with the worker file loaded from the vendor path. pdf-lib performs the edit: load the original bytes, build a new document, copyPages in the chosen order, and apply setRotation as the sum of the original rotation and the user rotation modulo 360. Save and trigger a Blob download. The model is a simple array of objects holding original index, extra rotation and deleted flag, so undo is a stack of snapshots.

Edge cases: pages with intrinsic rotation must show correctly in thumbnails, which pdfjs handles by its viewport. Very large PDFs: render thumbnails at width 160 pixels and cancel render tasks when cards leave the view. Password protected files show a not supported message. Landscape and portrait mixes keep a consistent card box. On mobile Safari, drag reorder is unreliable so the move buttons are always visible there. Free canvas memory by setting width to zero after drawing offscreen items. Saving all pages deleted is prevented with a message.

Demo data: a bundled fictional five page PDF titled Product Launch Deck for Aurora Labs where each page has a big number and a different background color, plus one landscape page to test rotation.
