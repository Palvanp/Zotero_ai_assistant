/**
 * Minimal loopback HTTP server built on nsIServerSocket.
 *
 * Why not Zotero's built-in server: it rejects any request with a `Mozilla/`
 * User-Agent (anti-DNS-rebinding), which we cannot work around for a page
 * opened in a real browser. Running our own server means the recorder page and
 * its upload are same-origin on a port we control — no UA guard, no CORS.
 *
 * Scope is deliberately tiny: loopback only, one request per connection,
 * Connection: close. Good enough for a localhost recorder handshake.
 */

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
}

export type HttpHandler = (
  req: HttpRequest,
) => HttpResponse | Promise<HttpResponse>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverSocket: any = null;

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  404: "Not Found",
  500: "Internal Server Error",
};

/**
 * Start the server. Pass `port` to pin it (handy for curl testing); the default
 * -1 lets the OS assign an ephemeral loopback port. Returns the actual port.
 */
export function startLocalServer(handler: HttpHandler, port = -1): number {
  stopLocalServer();
  serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket,
  );
  // init(port, loopbackOnly = true, backlog = -1)
  serverSocket.init(port, true, -1);
  serverSocket.asyncListen({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSocketAccepted(_socket: any, transport: any) {
      try {
        handleConnection(transport, handler);
      } catch (e) {
        ztoolkit.log("[localServer] connection error", e);
      }
    },
    onStopListening() {},
  });
  return serverSocket.port;
}

export function stopLocalServer() {
  if (serverSocket) {
    try {
      serverSocket.close();
    } catch {
      /* already closed */
    }
    serverSocket = null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleConnection(transport: any, handler: HttpHandler) {
  const rawInput = transport.openInputStream(0, 0, 0);
  const output = transport.openOutputStream(
    Ci.nsITransport.OPEN_BLOCKING,
    0,
    0,
  );
  const asyncInput = rawInput.QueryInterface(Ci.nsIAsyncInputStream);
  const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
    Ci.nsIBinaryInputStream,
  );
  binary.setInputStream(asyncInput);

  const mainThread = Services.tm.mainThread;
  let data = "";

  const finish = () => {
    Promise.resolve()
      .then(() => routeRequest(data, handler))
      .then((resp) => writeResponse(output, resp))
      .catch((e) =>
        writeResponse(output, {
          status: 500,
          contentType: "text/plain",
          body: `error: ${e}`,
        }),
      )
      .finally(() => {
        try {
          asyncInput.close();
        } catch {
          /* ignore */
        }
      });
  };

  const waiter = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onInputStreamReady() {
      let avail = 0;
      try {
        avail = asyncInput.available();
      } catch {
        finish(); // stream closed before a full request
        return;
      }
      if (avail > 0) {
        data += binary.readBytes(avail);
      }
      if (isRequestComplete(data)) {
        finish();
      } else {
        asyncInput.asyncWait(waiter, 0, 0, mainThread);
      }
    },
  };

  asyncInput.asyncWait(waiter, 0, 0, mainThread);
}

function isRequestComplete(data: string): boolean {
  const headerEnd = data.indexOf("\r\n\r\n");
  if (headerEnd === -1) return false;
  const m = /content-length:\s*(\d+)/i.exec(data.slice(0, headerEnd));
  const contentLength = m ? parseInt(m[1], 10) : 0;
  return data.length >= headerEnd + 4 + contentLength;
}

function routeRequest(
  data: string,
  handler: HttpHandler,
): HttpResponse | Promise<HttpResponse> {
  const headerEnd = data.indexOf("\r\n\r\n");
  const headerText = headerEnd === -1 ? data : data.slice(0, headerEnd);
  const requestLine = headerText.split("\r\n")[0] || "";
  const [method, target] = requestLine.split(" ");
  const body = headerEnd === -1 ? "" : data.slice(headerEnd + 4);
  const url = new URL(target || "/", "http://localhost");
  return handler({
    method: (method || "GET").toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    body,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeResponse(output: any, resp: HttpResponse) {
  const bodyBytes = toUtf8Bytes(resp.body);
  const head =
    `HTTP/1.1 ${resp.status} ${STATUS_TEXT[resp.status] || "OK"}\r\n` +
    `Content-Type: ${resp.contentType}\r\n` +
    `Content-Length: ${bodyBytes.length}\r\n` +
    `Access-Control-Allow-Origin: *\r\n` +
    `Connection: close\r\n\r\n`;
  const full = head + bodyBytes;
  const binaryOut = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
    Ci.nsIBinaryOutputStream,
  );
  binaryOut.setOutputStream(output);
  try {
    binaryOut.writeBytes(full, full.length);
  } catch (e) {
    ztoolkit.log("[localServer] write error", e);
  }
  try {
    binaryOut.close();
  } catch {
    /* ignore */
  }
}

/** JS string -> latin1 byte-string of its UTF-8 encoding (each char = 1 byte). */
function toUtf8Bytes(str: string): string {
  return unescape(encodeURIComponent(str));
}
