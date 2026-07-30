import { config } from "../../package.json";

/**
 * Groq API client (open-weight models only, per project scope).
 * - Speech-to-text: whisper-large-v3-turbo
 * - Text: llama-3.3-70b-versatile (used later for anchor resolution)
 *
 * Uses the main window's fetch/Blob/FormData/atob so we get real DOM Web APIs
 * rather than the plugin sandbox's limited globals.
 */

const GROQ_BASE = "https://api.groq.com/openai/v1";

export function getGroqApiKey(): string {
  return (
    (Zotero.Prefs.get(`${config.prefsPrefix}.groqApiKey`, true) as string) || ""
  );
}

const STT_PROMPT_MAX = 700; // whisper caps its prompt at ~224 tokens
const STT_TERMS_MAX = 350;
const STT_TERM_COUNT = 40;

/**
 * Whisper accepts a short text sample as a decoding hint. Feeding it the current
 * page's own jargon is what stops "DualSegFormer" coming back as
 * "GAL-Segg-WROMA". Distinctive tokens lead — they are what STT actually fumbles
 * — then page prose fills whatever budget is left.
 */
export function buildSttPrompt(pageText: string): string {
  const prose = pageText.replace(/\s+/g, " ").trim();

  // Interior capitals: catches FPANet, DualSegFormer, IoU, SAR, BERTScore, and
  // skips ordinary sentence-initial capitalisation.
  const terms = new Set<string>();
  const re = /\b[A-Za-z][A-Za-z0-9-]*[A-Z][A-Za-z0-9-]*\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null && terms.size < STT_TERM_COUNT) {
    if (m[0].length >= 3) terms.add(m[0]);
  }

  let head = "";
  for (const t of terms) {
    if (head.length + t.length + 2 > STT_TERMS_MAX) break;
    head = head ? `${head}, ${t}` : t;
  }

  const budget = STT_PROMPT_MAX - head.length - 2;
  const tail = budget > 80 ? prose.slice(0, budget) : "";
  return [head, tail].filter(Boolean).join(". ");
}

export async function transcribeAudio(
  apiKey: string,
  audioBase64: string,
  mimeType: string,
  vocabPrompt?: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = Zotero.getMainWindow() as any;

  const binary = win.atob(audioBase64);
  const bytes = new win.Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const ext = mimeType.includes("ogg")
    ? "ogg"
    : mimeType.includes("mp4")
      ? "mp4"
      : "webm";
  const blob = new win.Blob([bytes], { type: mimeType });

  const form = new win.FormData();
  form.append("file", blob, `audio.${ext}`);
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");
  if (vocabPrompt) form.append("prompt", vocabPrompt);

  const resp = await win.fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Groq STT ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  return (json.text || "").trim();
}

export interface Anchors {
  startText: string;
  endText: string;
  raw: string; // the model's unparsed reply, kept for the voice log
}

export interface AnchorRetry {
  previous: { startText: string; endText: string };
  problem: string;
}

const ANCHOR_SYSTEM_PROMPT =
  "You highlight text in a PDF page. Given a spoken command and the exact text " +
  "of the current page, identify the passage the user wants highlighted. " +
  'Respond ONLY with JSON {"startText":"...","endText":"..."}.\n' +
  "- Both values MUST be substrings copied VERBATIM from the page text " +
  "(identical characters, spacing and case). The page text is machine-extracted, " +
  "so it may contain joined-up words, missing spaces or odd line breaks. Copy " +
  "what is actually there, NOT the conventional spelling.\n" +
  "- startText = the first few words of the passage; endText = the LAST few " +
  "words of the passage. For a short passage they may be equal.\n" +
  "- endText must end where the user asked it to end. Do NOT extend it to the " +
  "end of the sentence or paragraph.\n" +
  "- The command is speech-to-text output, so technical terms may be misheard " +
  "phonetically. Map them to the closest-sounding phrase on the page rather " +
  "than widening the passage.\n" +
  "- If you cannot locate the passage, return empty strings.";

/**
 * Given the spoken command and the exact text of the current page, ask Llama
 * which passage to highlight, returned as verbatim start/end substrings of the
 * page text. This absorbs STT errors and loose phrasing. Pass `retry` to show
 * the model that its previous answer did not appear on the page.
 */
export async function resolveAnchors(
  apiKey: string,
  transcript: string,
  pageText: string,
  retry?: AnchorRetry,
): Promise<Anchors> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = Zotero.getMainWindow() as any;
  const messages: { role: string; content: string }[] = [
    { role: "system", content: ANCHOR_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Command: "${transcript}"\n\nPage text:\n"""\n${pageText}\n"""`,
    },
  ];
  if (retry) {
    messages.push({
      role: "assistant",
      content: JSON.stringify(retry.previous),
    });
    messages.push({ role: "user", content: retry.problem });
  }
  const body = {
    model: "llama-3.3-70b-versatile",
    temperature: 0,
    response_format: { type: "json_object" },
    messages,
  };
  const resp = await win.fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Groq chat ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content || "{}";
  let parsed: Partial<Anchors>;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {};
  }
  return {
    startText: String(parsed.startText || ""),
    endText: String(parsed.endText || ""),
    raw: content,
  };
}
