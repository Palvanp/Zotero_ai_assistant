# Zotero AI Reader

Voice-command PDF highlighting for [Zotero 7](https://www.zotero.org/). Open a
paper, click the 🎤 button in the reader toolbar, say _"highlight from
experimental results to DualSegFormer"_, and the passage gets highlighted.

> **Status: MVP.** The pipeline works end to end, but highlight edges are
> approximate and anchor resolution depends on an LLM picking the right passage.
> See [Known limitations](#known-limitations).

## How it works

```
🎤 button ──> browser recorder page ──> POST audio
                                            │
                          ┌─────────────────┘
                          v
              Whisper STT (+ page vocabulary hint)
                          │  transcript
                          v
              Llama anchor resolution ──> { startText, endText }
                          │
                          v
              locate in the reader's pdf.js text ──> rects
                          │
                          v
              Zotero.Annotations.saveFromJSON
```

The odd part is the browser round-trip. `getUserMedia` is blocked everywhere
inside Zotero's process, and Zotero's own HTTP server rejects browser
User-Agents — so the plugin runs its **own** loopback HTTP server, opens a
recorder page from it in your default browser (localhost is a secure context, so
the mic works there), and that page POSTs the audio back tagged with a session
token.

## Setup

1. Get a [Groq API key](https://console.groq.com/keys).
2. Install the plugin, open **Settings → Zotero AI Reader**, paste the key, and
   hit **Test key** to confirm it works.
3. Open a PDF and click 🎤 in the reader toolbar.

Speak naturally — _"highlight the bit from X to Y"_. The leading "highlight" and
any filler are ignored; only the start and end phrases matter.

## Source layout

| File                              | Role                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/modules/voiceCapture.ts`     | Toolbar button, session tokens, recorder page, and the pipeline tying it together        |
| `src/modules/localServer.ts`      | Minimal loopback HTTP server                                                             |
| `src/modules/groq.ts`             | Whisper transcription, Llama anchor resolution, and the page-derived STT vocabulary hint |
| `src/modules/highlighter.ts`      | Reads positioned text from the reader's pdf.js, matches anchors, computes rects          |
| `src/modules/voiceLog.ts`         | Appends one JSONL record per command, for diagnosing bad highlights                      |
| `src/modules/preferencePane.ts`   | Registers the Settings pane                                                              |
| `src/modules/preferenceScript.ts` | The Settings pane's "Test key" behaviour                                                 |
| `src/hooks.ts`                    | Plugin lifecycle: startup, shutdown, window load                                         |

## Anchor matching

The model is asked for two verbatim substrings of the page text. It reliably
fails to be verbatim — answering `"FPA Net"` for a page that reads `"FPANet"` —
so matching degrades through three tiers:

1. **exact** — literal `indexOf`
2. **normalized** — lowercase, letters and digits only, mapped back to real offsets
3. **partial** — progressively shorter prefixes of the anchor, floored at 60%

When the start anchor occurs several times, the `(start, end)` pair with the
**shortest span** wins; anchoring on the first occurrence and running to a
distant end anchor is how this over-highlights whole paragraphs.

If the end anchor can't be found at all, the plugin asks the model once more with
the failure spelled out, then **fails visibly rather than highlighting a span
nobody asked for**.

## Known limitations

- **Highlight edges are approximate.** pdf.js exposes one x/width per text
  _run_, not per character, and Zotero's reader exposes no char-level rects
  (verified: no `chars` on the view's page objects, no reachable text layer). So
  cutting a run mid-way is estimated from a glyph-width table — measured at 0.14
  characters mean error, versus 0.57 for splitting runs evenly.
- **Rect heights sit on the baseline**, so descenders (g, y, p) can clip.
- **Current page only.** A passage spanning a page break won't resolve.
- **Dev scaffolding remains in `voiceCapture.ts`** — the server port is pinned
  and a never-expiring debug session is seeded. Fine locally; remove both before
  distributing to anyone else.

## Development

```bash
npm install
cp .env.example .env    # set your Zotero binary + dev profile paths
npm start               # launches Zotero with the plugin, hot-reloads on save
npm run build           # builds the .xpi and typechecks
npm run lint:fix
```

`npm start` does not re-render an already-open reader tab, so after editing
source, **close and reopen the PDF** — otherwise the 🎤 button stays bound to the
previous module instance.

Every voice command appends a record to
`<Zotero data dir>/zoteroaireader-voicelog.jsonl` holding the transcript, the
anchors, how each anchor matched, the resulting span, and the rects. That file is
the fastest way to tell a bad transcription from a bad anchor from bad geometry.
There is also a `GET /debug` endpoint on the local server that dumps the
reachable pdf.js state for the current reader.

## Credits

Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
by windingwind. Speech and language models served by [Groq](https://groq.com/)
(`whisper-large-v3-turbo`, `llama-3.3-70b-versatile`).

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
