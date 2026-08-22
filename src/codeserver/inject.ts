import fs from "node:fs";
import http from "node:http";
import net from "node:net";

/** code-server in front of a proxy that puts tode's css into the workbench page.
 *
 * The page needs the css before its first paint, and reaching in over the
 * devtools protocol after the fact means a visible flash, so the html is edited
 * on its way through instead. Everything that is not the document is piped
 * straight across. Nothing but css goes in: the workbench's startup timing
 * lives in the browser preload (src/browser/preload.ts), and links that leave
 * the workbench open as terminal-browser's own popups over the pane
 * (--open-tabs-in-popup-stack). */
export const FONT_ROUTE = "/__tode/font.ttf";

/** The workbench's own settings, handed to it in the document.
 *
 * A vscode server serves the web workbench its user settings from the browser,
 * not from the profile directory on disk — so the settings.json tode writes is
 * read by the cli and by nothing else, and the theme, the font and the rest of
 * it never reach the page. What the page does take is
 * `configurationDefaults` in its construction options, which lands in the
 * default layer: tode's answers apply, and anything the user changes in the
 * editor still wins over them, which is the right way round.
 *
 * The options travel HTML-escaped in a meta tag, so they are unescaped, merged
 * and escaped back. Anything unexpected leaves the document alone. */
const WEB_CONFIGURATION =
  /(id="vscode-workbench-web-configuration"[^>]*?data-settings=")([^"]*)(")/;

/** Only the workbench document carries this tag, and it is the only html that
 * should get tode's css and options — with webviews served same-origin, their
 * documents flow through this proxy too, and a forced background would paint
 * over their content. */
export const WORKBENCH_MARKER = 'id="vscode-workbench-web-configuration"';

/** Where the server's own copy of the webview boot page lives, under the
 * /static route the web server serves its installation from. */
export const WEBVIEW_PRE_ROUTE = "/out/vs/workbench/contrib/webview/browser/pre/";

const unescapeAttribute = (value: string) =>
  value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

export interface PageOptions {
  webviewEndpoint?: string;
  remoteAuthority?: string;
}

export function withConfigurationDefaults(
  html: string,
  defaults: Record<string, unknown>,
  page: PageOptions = {},
): string {
  if (Object.keys(defaults).length === 0 && !page.webviewEndpoint && !page.remoteAuthority) {
    return html;
  }
  return html.replace(WEB_CONFIGURATION, (all, head: string, body: string, tail: string) => {
    let options: Record<string, unknown>;
    try {
      options = JSON.parse(unescapeAttribute(body)) as Record<string, unknown>;
    } catch {
      return all;
    }
    if (!options || typeof options !== "object") return all;
    const existing = (options.configurationDefaults ?? {}) as Record<string, unknown>;
    options.configurationDefaults = { ...defaults, ...existing };
    // webviews served from the page's own origin share its renderer process,
    // which is what lets the synthesized wheel and mouse events terminal-browser
    // sends reach them — the cdn origin in product.json makes them out-of-process
    // iframes that those events never hit. It also takes the network out of it.
    if (page.webviewEndpoint && !options.webviewEndpoint) {
      options.webviewEndpoint = page.webviewEndpoint;
    }
    // the server names ITSELF as the remote authority, but the page is served
    // by this proxy: a fetch of /vscode-remote-resource against the server's
    // own port is cross-origin from the page, and the server answers it with
    // no CORS headers, so every theme and extension resource dies with
    // "Failed to fetch". The page's own host is the authority that works —
    // resources and the connection both come back through this proxy.
    if (page.remoteAuthority) options.remoteAuthority = page.remoteAuthority;
    return head + escapeAttribute(JSON.stringify(options)) + tail;
  });
}

/** The webview boot page insists its hostname be a hash of the parent origin —
 * the shape its cdn hosting gives it, where every webview gets an isolating
 * subdomain. Served from the parent's own origin there is no subdomain to
 * check; being the parent's origin is the fact that matters, so the check
 * learns to accept it. The replacement is pinned to the exact source line the
 * vendored server ships; a build that changes it is caught by the pin bump. */
export function withSameOriginWebviews(html: string): string {
  return html.replace(
    "if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {",
    "if (parentOrigin === self.origin || hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {",
  );
}

export function createInjector(
  upstreamPort: number,
  cssFile: string,
  fontFile?: string,
  holdMs = 20_000,
  configFile?: string,
): http.Server {
  const upstreamHost = `127.0.0.1:${upstreamPort}`;

  const readCss = (): string => {
    try {
      return fs.readFileSync(cssFile, "utf8");
    } catch {
      return "";
    }
  };

  const readDefaults = (): Record<string, unknown> => {
    if (!configFile) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  // code-server checks that a request comes from its own origin, so the
  // rewritten headers have to say so even though the browser said otherwise
  const forwardHeaders = (incoming: http.IncomingHttpHeaders, wantsHtml: boolean) => {
    const headers: http.IncomingHttpHeaders = { ...incoming, host: upstreamHost };
    for (const name of ["origin", "referer"] as const) {
      const value = headers[name];
      if (typeof value === "string") {
        headers[name] = value.replace(/^https?:\/\/[^/]+/, `http://${upstreamHost}`);
      }
    }
    // an encoded body cannot be edited, so documents are asked for in the clear
    if (wantsHtml) headers["accept-encoding"] = "identity";
    return headers;
  };

  const started = Date.now();
  let everAnswered = false;
  const server: http.Server = http.createServer((request, response) => {
    // serving the font here means the page has it whether or not it was ever
    // installed into the operating system
    if (fontFile && request.url?.startsWith(FONT_ROUTE)) {
      try {
        const font = fs.readFileSync(fontFile);
        response.writeHead(200, {
          "content-type": "font/ttf",
          "content-length": String(font.byteLength),
          "cache-control": "public, max-age=31536000, immutable",
        });
        response.end(font);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    const wantsHtml = (request.headers.accept ?? "").includes("text/html");
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: forwardHeaders(request.headers, wantsHtml),
      },
      (from) => {
        everAnswered = true;
        const type = from.headers["content-type"] ?? "";
        if (!type.includes("text/html")) {
          response.writeHead(from.statusCode ?? 502, from.headers);
          from.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        from.on("data", (chunk: Buffer) => chunks.push(chunk));
        from.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const css = readCss();
          let patched = body;
          if (body.includes(WORKBENCH_MARKER)) {
            const host = request.headers.host;
            patched = withConfigurationDefaults(
              body,
              readDefaults(),
              host
                ? {
                    webviewEndpoint: `http://${host}/static${WEBVIEW_PRE_ROUTE}`,
                    remoteAuthority: host,
                  }
                : {},
            );
            if (css) {
              const style = `<style id="tode-injected">${css}</style>`;
              patched = patched.includes("</head>")
                ? patched.replace("</head>", `${style}</head>`)
                : `${style}${patched}`;
            }
          } else if (request.url?.includes(WEBVIEW_PRE_ROUTE)) {
            patched = withSameOriginWebviews(body);
          }
          const out = Buffer.from(patched, "utf8");
          const headers = { ...from.headers, "content-length": String(out.byteLength) };
          delete headers["content-encoding"];
          // the whole body is in hand now, and a length cannot be sent alongside
          // the chunked encoding the upstream may have used
          delete headers["transfer-encoding"];
          response.writeHead(from.statusCode ?? 200, headers);
          response.end(out);
        });
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      // code-server may still be booting: the browser was started alongside it
      // rather than after it, so the request waits instead of failing
      if (error.code === "ECONNREFUSED" && !everAnswered && Date.now() - started < holdMs) {
        setTimeout(() => server.emit("request", request, response), 60);
        return;
      }
      if (!response.headersSent) response.writeHead(502);
      response.end("tode: code-server is not answering\n");
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, client: net.Socket, clientHead: Buffer) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: forwardHeaders(request.headers, false),
    });
    upstream.on("upgrade", (from, target: net.Socket, upstreamHead: Buffer) => {
      const lines = Object.entries(from.headers).map(([name, value]) => `${name}: ${value}`);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      // whatever arrived in the same packet as each handshake belongs to the
      // other end, and has already been read off its socket
      if (upstreamHead?.length) client.write(upstreamHead);
      if (clientHead?.length) target.write(clientHead);
      target.pipe(client);
      client.pipe(target);
      // an upgraded socket allows half open, so a browser going away shows up as
      // "end" and never as "close". Watching only for close would leave the
      // connection to code-server behind on every reload.
      const drop = () => {
        target.destroy();
        client.destroy();
      };
      for (const event of ["end", "close", "error"] as const) {
        target.on(event, drop);
        client.on(event, drop);
      }
    });
    upstream.on("error", () => client.destroy());
    upstream.end();
  });

  return server;
}


export const FONT_FALLBACKS = `Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace`;

export function injectedCss(background: string, fontFamily: string): string {
  const stack = `"${fontFamily}", ${FONT_FALLBACKS}`;
  return [
    `@font-face{font-family:"${fontFamily}";src:url("${FONT_ROUTE}") format("truetype");font-weight:100 900;font-display:block;}`,
    `html,body{background:${background} !important;}`,
    "html{overflow:hidden;}",
    "body{margin:0;}",
    `.monaco-workbench{background:${background};font-family:${stack} !important;}`,
    `.monaco-workbench .part,.monaco-workbench .monaco-list,.monaco-workbench .monaco-inputbox,`,
    `.monaco-workbench input,.monaco-workbench select,.monaco-workbench textarea,`,
    `.monaco-menu,.quick-input-widget,.monaco-hover,.notifications-toasts`,
    `{font-family:${stack} !important;}`,
    `:root{--monaco-monospace-font:${stack};}`,
    ".editor-group-watermark{display:none !important;}",
  ].join("");
}
