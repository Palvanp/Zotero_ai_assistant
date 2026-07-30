/**
 * Turns a target text span into Zotero highlight rectangles by reusing the
 * reader's ALREADY-LOADED pdf.js document (Option A). This reaches into
 * undocumented reader internals:
 *   reader._internalReader._primaryView._iframeWindow.PDFViewerApplication
 * If a future Zotero build breaks that path, the fallback is to bundle
 * pdfjs-dist and load the file ourselves (Option B).
 */

interface PageItem {
  str: string;
  x: number; // PDF points, origin bottom-left
  y: number; // baseline y
  w: number;
  h: number;
}

export interface PageData {
  pageIndex: number;
  pageText: string;
  items: PageItem[];
  itemOffsets: number[]; // start offset of each item's str within pageText
  pageHeight: number;
}

/** How closely an anchor string matched the page text. */
export type MatchKind =
  | "exact" // found character-for-character
  | "normalized" // found ignoring case, spacing and punctuation
  | "partial" // only a leading portion of the anchor was found
  | "missing" // an end anchor was requested but never located
  | "none"; // no end anchor was requested

export interface HighlightMatch {
  rects: number[][]; // [[x1,y1,x2,y2], ...]
  text: string;
  rangeStart: number; // offsets into pageText, for diagnostics
  rangeEnd: number;
  startMatch: MatchKind;
  endMatch: MatchKind;
  startCandidates: number; // occurrences of startText considered
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPdfApp(reader: any): any {
  const view = reader?._internalReader?._primaryView;
  const win = view?._iframeWindow;
  // PDFViewerApplication is a page-script global on the pdf.js iframe window;
  // Xray wrappers hide such expandos from chrome, so prefer wrappedJSObject.
  return win?.wrappedJSObject?.PDFViewerApplication || win?.PDFViewerApplication;
}

/** Read positioned text for the reader's current page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getReaderPageData(reader: any): Promise<PageData> {
  // Content objects reach chrome behind Xray wrappers that hide pdf.js
  // prototype methods (getTextContent etc.), and every `await` re-wraps the
  // resolved value — so waive Xrays right after each await.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Cu = (Components as any).utils;
  const pageIndex: number = reader?.state?.pageIndex ?? 0;
  const app = getPdfApp(reader);
  if (!app?.pdfDocument) {
    throw new Error("Could not reach the reader's PDF document.");
  }
  const doc = Cu.waiveXrays(app.pdfDocument);
  const page = Cu.waiveXrays(await doc.getPage(pageIndex + 1));
  const textContent = Cu.waiveXrays(await page.getTextContent());
  const box = page.view; // [x0, y0, x1, y1]
  const pageHeight = box[3] - box[1];

  const items: PageItem[] = [];
  const itemOffsets: number[] = [];
  let pageText = "";

  const raw = textContent.items;
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    const str: string = it.str || "";
    const t = it.transform;
    itemOffsets.push(pageText.length);
    items.push({
      str,
      x: t[4],
      y: t[5],
      w: it.width || 0,
      h: Math.abs(t[3]) || it.height || 0,
    });
    pageText += str;
    pageText += it.hasEOL ? "\n" : " ";
  }

  return { pageIndex, pageText, items, itemOffsets, pageHeight };
}

/**
 * The page text as lowercased letters+digits only, plus a map back to offsets in
 * the source. Anchors are matched in this space because the model reliably
 * normalises what it copies — it answers "FPA Net" for a page that reads
 * "FPANet" — and because pdf.js sprinkles separators between text items, so the
 * page itself contains spacing that exists in no human-readable rendering.
 */
interface Normalized {
  norm: string;
  map: number[]; // map[i] = index in the source string of norm[i]
}

const ALNUM = /[\p{L}\p{N}]/u;

function normalize(s: string): Normalized {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!ALNUM.test(ch)) continue;
    // toLowerCase can expand one char into several; push per output char so
    // norm and map stay the same length.
    const low = ch.toLowerCase();
    for (let k = 0; k < low.length; k++) {
      norm += low[k];
      map.push(i);
    }
  }
  return { norm, map };
}

interface Span {
  start: number; // offset in pageText
  end: number; // offset in pageText, exclusive
  kind: MatchKind;
}

function normSpan(
  pageNorm: Normalized,
  at: number,
  len: number,
  kind: MatchKind,
): Span {
  return { start: pageNorm.map[at], end: pageNorm.map[at + len - 1] + 1, kind };
}

/** Lowest normalized index that maps at or past `from` in the source. */
function normIndexAt(pageNorm: Normalized, from: number): number {
  let i = 0;
  while (i < pageNorm.map.length && pageNorm.map[i] < from) i++;
  return i;
}

/**
 * Find `needle` in the page at or after `from`, degrading through three tiers:
 * literal, normalized, then progressively shorter prefixes of the needle. The
 * model garbles the tail of an anchor far more often than the head, so dropping
 * from the end is the useful direction.
 */
function findSpan(
  pageText: string,
  pageNorm: Normalized,
  needle: string,
  from: number,
): Span | null {
  if (!needle) return null;

  const literal = pageText.indexOf(needle, from);
  if (literal !== -1) {
    return { start: literal, end: literal + needle.length, kind: "exact" };
  }

  const n = normalize(needle).norm;
  if (!n) return null;
  const fromNorm = normIndexAt(pageNorm, from);

  const at = pageNorm.norm.indexOf(n, fromNorm);
  if (at !== -1) return normSpan(pageNorm, at, n.length, "normalized");

  // Require most of the anchor to survive, so we never anchor on a few stray
  // letters that happen to appear somewhere unrelated.
  const floor = Math.max(10, Math.ceil(n.length * 0.6));
  for (let len = n.length - 1; len >= floor; len--) {
    const p = pageNorm.norm.indexOf(n.slice(0, len), fromNorm);
    if (p !== -1) return normSpan(pageNorm, p, len, "partial");
  }
  return null;
}

const MAX_START_CANDIDATES = 8;

/**
 * Every occurrence of startText at the tier where it first matched. A partial
 * match already means we are guessing, so it is never enumerated further.
 */
function collectStartSpans(
  pageText: string,
  pageNorm: Normalized,
  startText: string,
): Span[] {
  const first = findSpan(pageText, pageNorm, startText, 0);
  if (!first) return [];
  const spans = [first];
  if (first.kind === "partial") return spans;

  let from = first.start + 1;
  while (spans.length < MAX_START_CANDIDATES) {
    const next = findSpan(pageText, pageNorm, startText, from);
    if (!next || next.kind !== first.kind) break;
    spans.push(next);
    from = next.start + 1;
  }
  return spans;
}

interface ClippedItem {
  x1: number;
  x2: number;
  y: number;
  h: number;
}

/**
 * Approximate advance widths, relative to an average glyph. pdf.js hands us one
 * x/width per text run with no per-character breakdown, and the reader exposes
 * no char-level rects (checked: no `chars` on the view's page objects, no
 * reachable text layer), so cutting a run mid-way means estimating. Weighting by
 * glyph shape rather than assuming uniform width keeps a proportional font's
 * boundary within roughly a character; splitting a run evenly does not.
 */
const NARROW = new Set("ijltfIrJ.,;:'\"!|()[]{}`-/\\");
const WIDE = new Set("mwMW@%&GOQD");

function charWidth(ch: string): number {
  if (ch === " ") return 0.5;
  if (NARROW.has(ch)) return 0.45;
  if (WIDE.has(ch)) return 1.5;
  if (ch >= "A" && ch <= "Z") return 1.25;
  return 1;
}

/** Summed advance width of str[from, to). */
function advance(str: string, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i++) total += charWidth(str[i]);
  return total;
}

/** Locate startText..endText in the page and clip the covered items into rects. */
export function computeHighlightRects(
  page: PageData,
  startText: string,
  endText: string,
): HighlightMatch | null {
  const { pageText, items, itemOffsets } = page;
  if (!startText) return null;

  const pageNorm = normalize(pageText);
  const starts = collectStartSpans(pageText, pageNorm, startText);
  if (!starts.length) return null;

  let chosenStart = starts[0];
  let rangeEnd = chosenStart.end;
  let endMatch: MatchKind = endText ? "missing" : "none";

  if (endText) {
    // Pick the (start, end) pair with the shortest span. Anchoring on the first
    // occurrence of a repeated phrase and then running to a far-away end anchor
    // is how this over-highlights whole paragraphs.
    let best: { start: Span; end: Span } | null = null;
    for (const s of starts) {
      const e = findSpan(pageText, pageNorm, endText, s.start);
      if (!e || e.end <= s.start) continue;
      if (!best || e.end - s.start < best.end.end - best.start.start) {
        best = { start: s, end: e };
      }
    }
    if (best) {
      chosenStart = best.start;
      rangeEnd = best.end.end;
      endMatch = best.end.kind;
    }
  }
  const rangeStart = chosenStart.start;

  // Items whose str overlaps [rangeStart, rangeEnd), each CLIPPED to the range.
  // A text item is a whole run — often most of a line — so taking its full
  // x-extent is what made a passage starting mid-line paint from the margin.
  const covered: ClippedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const s = itemOffsets[i];
    const e = s + it.str.length;
    if (s >= rangeEnd || e <= rangeStart || !it.str.trim()) continue;

    const from = Math.max(0, rangeStart - s);
    const to = Math.min(it.str.length, rangeEnd - s);
    if (to <= from) continue;

    const total = advance(it.str, 0, it.str.length);
    const x1 =
      total > 0 ? it.x + (it.w * advance(it.str, 0, from)) / total : it.x;
    const x2 =
      total > 0 ? it.x + (it.w * advance(it.str, 0, to)) / total : it.x + it.w;
    covered.push({ x1, x2, y: it.y, h: it.h });
  }
  if (!covered.length) return null;

  // Group into lines by rounded baseline y, then one rect per line.
  const lines = new Map<number, ClippedItem[]>();
  for (const it of covered) {
    const key = Math.round(it.y);
    const group = lines.get(key);
    if (group) group.push(it);
    else lines.set(key, [it]);
  }

  const rects: number[][] = [];
  for (const group of lines.values()) {
    const x1 = Math.min(...group.map((g) => g.x1));
    const x2 = Math.max(...group.map((g) => g.x2));
    const y1 = Math.min(...group.map((g) => g.y));
    const y2 = Math.max(...group.map((g) => g.y + g.h));
    rects.push([x1, y1, x2, y2]);
  }

  const text = pageText.slice(rangeStart, rangeEnd).replace(/\s+/g, " ").trim();
  return {
    rects,
    text,
    rangeStart,
    rangeEnd,
    startMatch: chosenStart.kind,
    endMatch,
    startCandidates: starts.length,
  };
}

function computeSortIndex(
  pageIndex: number,
  rects: number[][],
  pageHeight: number,
): string {
  // Top of the span = highest y (PDF origin is bottom-left); convert to a
  // top-down offset for Zotero's ordering.
  const topY = Math.max(...rects.map((r) => r[3]));
  const topOffset = Math.max(Math.round(pageHeight - topY), 0);
  return (
    String(pageIndex).padStart(5, "0") +
    "|" +
    String(topOffset).padStart(6, "0") +
    "|00000"
  );
}

/** Create the highlight annotation. Returns the created item. */
export async function createHighlight(
  itemID: number,
  pageIndex: number,
  rects: number[][],
  text: string,
  pageHeight: number,
) {
  const attachment = Zotero.Items.get(itemID);
  const json = {
    key: Zotero.Utilities.generateObjectKey(),
    libraryID: attachment.libraryID,
    type: "highlight",
    text,
    color: "#ffd400",
    pageLabel: String(pageIndex + 1),
    sortIndex: computeSortIndex(pageIndex, rects, pageHeight),
    position: { pageIndex, rects },
    readOnly: false,
    dateModified: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return Zotero.Annotations.saveFromJSON(attachment, json);
}
