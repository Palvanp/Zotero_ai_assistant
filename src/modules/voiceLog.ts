import { config } from "../../package.json";

/**
 * Appends one JSON record per voice command to a JSONL file in Zotero's data
 * directory, so every stage (transcript, LLM anchors, resulting rects) is kept
 * for reviewing edge cases. One JSON object per line — grep- and parse-friendly.
 */

let cachedPath = "";

export function voiceLogPath(): string {
  if (!cachedPath) {
    cachedPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      `${config.addonRef}-voicelog.jsonl`,
    );
  }
  return cachedPath;
}

export interface VoiceLogRecord {
  status: string;
  itemID: number;
  pageIndex?: number;
  audioBytes?: number;
  mimeType?: string;
  sttPrompt?: string;
  transcript?: string;
  pageTextLen?: number;
  anchors?: { startText: string; endText: string; retried?: boolean };
  llmRaw?: string;
  // How the anchors actually landed on the page. Without this a missed end
  // anchor is indistinguishable from a clean single-line highlight.
  match?: {
    startMatch: string;
    endMatch: string;
    rangeStart: number;
    rangeEnd: number;
    spanChars: number;
    startCandidates: number;
  };
  result?: { text: string; rects: number[][] };
  error?: string;
}

// Appends are serialised through this chain. Overlapping IOUtils.write calls
// tore a record in half mid-field once, which made the log unparseable exactly
// when it was being used to diagnose something.
let writeChain: Promise<void> = Promise.resolve();

async function writeRecord(record: VoiceLogRecord): Promise<void> {
  const line =
    JSON.stringify({ time: new Date().toISOString(), ...record }) + "\n";
  try {
    const bytes = new TextEncoder().encode(line);
    await IOUtils.write(voiceLogPath(), bytes, { mode: "appendOrCreate" });
  } catch (e) {
    // Fallback for older IOUtils without appendOrCreate.
    try {
      let prev = "";
      try {
        prev = new TextDecoder().decode(await IOUtils.read(voiceLogPath()));
      } catch {
        /* file doesn't exist yet */
      }
      // A failed append can leave a partial line behind; drop it rather than
      // carrying the corruption forward.
      prev = prev.replace(/[^\n]*$/, "");
      await IOUtils.write(
        voiceLogPath(),
        new TextEncoder().encode(prev + line),
      );
    } catch (e2) {
      ztoolkit.log("[VoiceLog] write failed", e, e2);
    }
  }
}

export function appendVoiceLog(record: VoiceLogRecord): Promise<void> {
  writeChain = writeChain.then(() => writeRecord(record));
  return writeChain;
}
