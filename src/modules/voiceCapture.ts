import { config } from "../../package.json";
import {
  startLocalServer,
  stopLocalServer,
  HttpRequest,
  HttpResponse,
} from "./localServer";
import {
  getGroqApiKey,
  transcribeAudio,
  resolveAnchors,
  buildSttPrompt,
} from "./groq";
import {
  getReaderPageData,
  computeHighlightRects,
  createHighlight,
} from "./highlighter";
import { appendVoiceLog, VoiceLogRecord } from "./voiceLog";

/**
 * Voice capture via browser round-trip.
 *
 * getUserMedia is blocked everywhere inside Zotero's process, and Zotero's own
 * HTTP server rejects browser User-Agents — so this plugin runs its OWN tiny
 * loopback HTTP server (see localServer.ts). A reader-toolbar button opens a
 * recorder page from that server in the user's default browser; localhost is a
 * secure context, so getUserMedia + MediaRecorder work there. The page POSTs
 * the captured audio back to the same server, tagged with a session token that
 * maps to the reader's attachment item.
 */

interface Session {
  itemID: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader?: any; // the open reader instance, for pdf.js access
  createdAt: number;
}

// token -> session; short-lived, in-memory only
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 5 * 60 * 1000;

let serverPort = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastReader: any = null; // TEMP DEBUG: most recent reader, for /debug

function serverOrigin(): string {
  return `http://127.0.0.1:${serverPort}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeKeys(o: any): string[] {
  try {
    return Object.keys(o).slice(0, 100);
  } catch {
    return ["<keys error>"];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fnNames(obj: any): string[] {
  const names = new Set<string>();
  let o = obj;
  for (let depth = 0; depth < 4 && o; depth++) {
    for (const k of Object.getOwnPropertyNames(o)) {
      try {
        if (typeof obj[k] === "function") names.add(k);
      } catch {
        /* getter threw */
      }
    }
    o = Object.getPrototypeOf(o);
  }
  return [...names];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pdfDebug(reader: any): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = {};
  try {
    d.hasReader = !!reader;
    d.pageIndex = reader?.state?.pageIndex;
    const internal = reader?._internalReader;
    d.hasInternal = !!internal;
    const view = internal?._primaryView;
    d.hasPrimaryView = !!view;
    d.viewKeys = view ? safeKeys(view) : null;
    const win = view?._iframeWindow;
    d.hasIframeWindow = !!win;
    const app =
      win?.wrappedJSObject?.PDFViewerApplication || win?.PDFViewerApplication;
    d.hasApp = !!app;
    d.appKeys = app ? safeKeys(app) : null;
    const doc = app?.pdfDocument;
    d.hasPdfDocument = !!doc;
    d.docNumPages = doc?.numPages;
    d.docGetPageType = typeof doc?.getPage;
    if (doc?.getPage) {
      const page = await doc.getPage((reader?.state?.pageIndex ?? 0) + 1);
      d.pageOwnKeys = safeKeys(page);
      d.pageFns = fnNames(page);
    }
    // Reader's own per-page char data, if present.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pages = view?._pages;
    d.hasInternalPages = !!pages;
    d.internalPagesLen = pages?.length;
    if (pages?.length) {
      const p = pages[reader?.state?.pageIndex ?? 0] || pages[0];
      d.internalPageKeys = p ? safeKeys(p) : null;
      d.charsLen = p?.chars?.length;
      if (p?.chars?.length) {
        d.sampleChar = JSON.stringify(p.chars[0]).slice(0, 400);
      }
    }
    // Try the real extraction path.
    try {
      const pd = await getReaderPageData(reader);
      d.extractOK = true;
      d.pageTextLen = pd.pageText.length;
      d.itemCount = pd.items.length;
      d.pageHeight = pd.pageHeight;
      d.pageTextSample = pd.pageText.slice(0, 250);
      d.sampleItem = pd.items[0];
    } catch (e) {
      d.extractOK = false;
      d.extractError = String(e);
    }
  } catch (e) {
    d.error = String(e);
  }
  return d;
}

function newToken(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}

/**
 * Full pipeline once audio arrives:
 * Groq STT -> Llama anchor resolution -> PDF geometry -> saveFromJSON.
 */
async function onAudioReceived(
  session: Session,
  audioBase64: string,
  mimeType: string,
) {
  const approxBytes = Math.floor((audioBase64?.length || 0) * 0.75);
  const rec: VoiceLogRecord = {
    status: "started",
    itemID: session.itemID,
    audioBytes: approxBytes,
    mimeType,
  };
  ztoolkit.log(
    `[VoiceCapture] audio received for item ${session.itemID}: ~${approxBytes} bytes, ${mimeType}`,
  );

  const apiKey = getGroqApiKey();
  if (!apiKey) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
      .createLine({
        text: "No Groq API key set (Settings → Zotero AI Reader).",
        type: "fail",
      })
      .show();
    rec.status = "no-api-key";
    appendVoiceLog(rec);
    return;
  }

  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeTime: -1,
  })
    .createLine({ text: "Reading the page…", type: "default", progress: 15 })
    .show();

  try {
    // The page comes first: its text doubles as the speech-to-text vocabulary
    // hint, and failing here is cheaper than after a transcription round-trip.
    if (!session.reader) {
      progress.changeLine({
        text: "No open reader for this command.",
        type: "fail",
      });
      progress.startCloseTimer(6000);
      rec.status = "no-reader";
      return;
    }
    const pageData = await getReaderPageData(session.reader);
    rec.pageIndex = pageData.pageIndex;
    rec.pageTextLen = pageData.pageText.length;

    progress.changeLine({
      text: "Transcribing…",
      type: "default",
      progress: 35,
    });
    const sttPrompt = buildSttPrompt(pageData.pageText);
    rec.sttPrompt = sttPrompt;
    const transcript = await transcribeAudio(
      apiKey,
      audioBase64,
      mimeType,
      sttPrompt,
    );
    rec.transcript = transcript;
    ztoolkit.log(`[VoiceCapture] transcript: ${transcript}`);
    if (!transcript) {
      progress.changeLine({ text: "Heard nothing.", type: "fail" });
      progress.startCloseTimer(6000);
      rec.status = "no-transcript";
      return;
    }
    progress.changeLine({
      text: `Heard: "${transcript}"`,
      type: "default",
      progress: 65,
    });

    let anchors = await resolveAnchors(apiKey, transcript, pageData.pageText);
    let result = computeHighlightRects(
      pageData,
      anchors.startText,
      anchors.endText,
    );
    let retried = false;

    // A missed end anchor used to silently collapse the range down to startText
    // and log as a success. Show the model its own failure once, then give up
    // loudly rather than highlighting a span nobody asked for.
    if (!result || result.endMatch === "missing") {
      retried = true;
      const problem = !result
        ? `startText ${JSON.stringify(anchors.startText)} does not appear on the page.`
        : `endText ${JSON.stringify(anchors.endText)} does not appear on the page.`;
      anchors = await resolveAnchors(apiKey, transcript, pageData.pageText, {
        previous: { startText: anchors.startText, endText: anchors.endText },
        problem:
          `${problem} Copy the passage's opening and closing words exactly as ` +
          `they appear in the page text above, including any unusual spacing or ` +
          `joined-up spelling. Keep the passage no longer than what was asked for.`,
      });
      result = computeHighlightRects(
        pageData,
        anchors.startText,
        anchors.endText,
      );
    }

    rec.anchors = {
      startText: anchors.startText,
      endText: anchors.endText,
      retried,
    };
    rec.llmRaw = anchors.raw;
    ztoolkit.log(
      `[VoiceCapture] anchors: start="${anchors.startText}" ` +
        `end="${anchors.endText}" retried=${retried}`,
    );

    if (!result || !result.rects.length) {
      progress.changeLine({
        text: `Couldn't locate that passage on this page.`,
        type: "fail",
      });
      progress.startCloseTimer(7000);
      rec.status = "no-match";
      return;
    }
    rec.match = {
      startMatch: result.startMatch,
      endMatch: result.endMatch,
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      spanChars: result.rangeEnd - result.rangeStart,
      startCandidates: result.startCandidates,
    };
    ztoolkit.log(
      `[VoiceCapture] match: start=${result.startMatch} end=${result.endMatch} ` +
        `span=${result.rangeEnd - result.rangeStart} chars`,
    );

    if (result.endMatch === "missing") {
      progress.changeLine({
        text: "Found the start but not the end of that passage — try saying the closing words again.",
        type: "fail",
      });
      progress.startCloseTimer(7000);
      rec.status = "end-anchor-missing";
      return;
    }
    rec.result = { text: result.text, rects: result.rects };

    await createHighlight(
      session.itemID,
      pageData.pageIndex,
      result.rects,
      result.text,
      pageData.pageHeight,
    );
    progress.changeLine({
      text: `Highlighted: "${result.text}"`,
      type: "success",
      progress: 100,
    });
    progress.startCloseTimer(6000);
    rec.status = "highlighted";
  } catch (e) {
    ztoolkit.log("[VoiceCapture] pipeline error", e);
    progress.changeLine({ text: `Failed: ${e}`, type: "fail" });
    progress.startCloseTimer(8000);
    rec.status = "error";
    rec.error = String(e);
  } finally {
    appendVoiceLog(rec);
  }
}

// --- Recorder page served to the browser ---
function recorderPageHtml(token: string): string {
  const cfg = { token, uploadUrl: `${serverOrigin()}/upload` };
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
    "<title>Zotero AI Reader — Voice</title>" +
    "<style>" +
    "body{font-family:system-ui,sans-serif;background:#1c1c1e;color:#eee;" +
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "height:100vh;margin:0;gap:20px;text-align:center;padding:16px;box-sizing:border-box}" +
    "#status{font-size:18px;max-width:32ch;line-height:1.4}" +
    ".dot{width:16px;height:16px;border-radius:50%;background:#ff453a;display:inline-block;" +
    "margin-right:8px;animation:pulse 1s infinite}" +
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}" +
    "button{font-size:16px;padding:12px 24px;border:0;border-radius:10px;cursor:pointer}" +
    "#stop{background:#ff453a;color:#fff}#cancel{background:#3a3a3c;color:#eee}" +
    ".row{display:flex;gap:12px}" +
    "</style></head><body>" +
    "<div id='status'>Requesting microphone…</div>" +
    "<div class='row'>" +
    "<button id='stop'>Stop &amp; Highlight</button>" +
    "<button id='cancel'>Cancel</button>" +
    "</div>" +
    "<script>window.__CFG__=" +
    JSON.stringify(cfg) +
    ";</script>" +
    "<script>" +
    RECORDER_SCRIPT +
    "</script>" +
    "</body></html>"
  );
}

// Runs in the browser, not in Zotero — kept as a plain string so no bundler/TS
// DOM typing is involved.
const RECORDER_SCRIPT = [
  "var cfg=window.__CFG__;",
  "var statusEl=document.getElementById('status');",
  "var stopBtn=document.getElementById('stop');",
  "var cancelBtn=document.getElementById('cancel');",
  "var chunks=[];var rec=null;var stream=null;",
  "function status(t,recording){statusEl.innerHTML=(recording?\"<span class='dot'></span>\":'')+t;}",
  "function b64(blob){return new Promise(function(res,rej){var r=new FileReader();",
  "r.onloadend=function(){res(String(r.result).split(',')[1]);};r.onerror=rej;r.readAsDataURL(blob);});}",
  "async function onStop(){status('Uploading…');",
  "var blob=new Blob(chunks,{type:(rec&&rec.mimeType)||'audio/webm'});",
  "try{var audio=await b64(blob);",
  "var resp=await fetch(cfg.uploadUrl,{method:'POST',headers:{'Content-Type':'application/json'},",
  "body:JSON.stringify({token:cfg.token,audioBase64:audio,mimeType:blob.type})});",
  "if(resp.ok){status('Done! You can close this tab.');setTimeout(function(){try{window.close();}catch(e){}},400);}",
  "else{status('Upload failed: '+resp.status);}}catch(e){status('Upload error: '+e);}",
  "if(stream){stream.getTracks().forEach(function(t){t.stop();});}}",
  "async function start(){",
  "try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}",
  "catch(e){status('Microphone error: '+e+'. Allow mic access and reopen.');return;}",
  "rec=new MediaRecorder(stream);",
  "rec.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data);};",
  "rec.onstop=onStop;rec.start();",
  "status('Recording — speak your highlight command, then click Stop.',true);}",
  "stopBtn.onclick=function(){if(rec&&rec.state!=='inactive')rec.stop();};",
  "cancelBtn.onclick=function(){if(stream)stream.getTracks().forEach(function(t){t.stop();});try{window.close();}catch(e){}};",
  "start();",
].join("\n");

// --- Request routing for our local server ---
async function handleRequest(req: HttpRequest): Promise<HttpResponse> {
  pruneSessions();

  if (req.method === "GET" && req.path === "/debug") {
    const d = await pdfDebug(lastReader);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(d, null, 2),
    };
  }

  if (req.method === "GET" && req.path === "/record") {
    const token = req.query.get("token") || "";
    if (!token || !sessions.has(token)) {
      return {
        status: 400,
        contentType: "text/plain",
        body: "Invalid or expired session token.",
      };
    }
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: recorderPageHtml(token),
    };
  }

  if (req.method === "POST" && req.path === "/upload") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = {};
    try {
      data = JSON.parse(req.body || "{}");
    } catch {
      /* leave data empty */
    }
    const { token, audioBase64, mimeType } = data;
    const session = token ? sessions.get(token) : undefined;
    if (!session) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid token" }),
      };
    }
    sessions.delete(token);
    try {
      onAudioReceived(session, audioBase64, mimeType || "audio/webm");
    } catch (e) {
      ztoolkit.log("[VoiceCapture] onAudioReceived error", e);
    }
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    };
  }

  return { status: 404, contentType: "text/plain", body: "Not found" };
}

// --- Reader toolbar button ---
const BTN_ID = `${config.addonRef}-voice-btn`;

const onToolbarRender = (
  event: _ZoteroTypes.Reader.EventParams<"renderToolbar">,
) => {
  const { reader, doc, append } = event;
  lastReader = reader; // TEMP DEBUG
  // Guard against duplicate buttons if the listener is registered more than
  // once (e.g. across dev hot-reloads).
  doc.getElementById(BTN_ID)?.remove();
  const btn = doc.createElement("button");
  btn.id = BTN_ID;
  btn.textContent = "🎤";
  btn.title = "Voice highlight";
  btn.style.marginInlineStart = "4px";
  btn.style.cursor = "pointer";
  btn.addEventListener("click", () => {
    const itemID = reader.itemID;
    if (!itemID) {
      doc.defaultView?.alert("Could not determine the current PDF attachment.");
      return;
    }
    if (!serverPort) {
      doc.defaultView?.alert("Voice server is not running.");
      return;
    }
    const token = newToken();
    sessions.set(token, { itemID, reader, createdAt: Date.now() });
    Zotero.launchURL(`${serverOrigin()}/record?token=${token}`);
  });
  append(btn);
};

export function registerVoiceCapture() {
  try {
    // TEMP DEV: pin the port (23789) so curl can reach it, and seed a
    // never-expiring session so the recorder page can be fetched without a
    // real button click. Switch to ephemeral (startLocalServer(handleRequest))
    // and drop the seed before shipping.
    serverPort = startLocalServer(handleRequest, 23789);
    sessions.set("debugtest", {
      itemID: 0,
      createdAt: Date.now() + 10 * 365 * 24 * 3600 * 1000,
    });
    ztoolkit.log(`[VoiceCapture] local server listening on port ${serverPort}`);
  } catch (e) {
    ztoolkit.log("[VoiceCapture] failed to start local server", e);
    serverPort = 0;
  }
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    onToolbarRender,
    config.addonID,
  );
}

export function unregisterVoiceCapture() {
  try {
    Zotero.Reader.unregisterEventListener("renderToolbar", onToolbarRender);
  } catch (e) {
    ztoolkit.log("[VoiceCapture] unregister listener failed", e);
  }
  stopLocalServer();
  serverPort = 0;
}
