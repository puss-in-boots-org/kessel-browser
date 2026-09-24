// A tiny local website for the tests, on 127.0.0.2 -- still this PC, but not
// an address Kessel treats as its own (127.0.0.1 / localhost are), so pages
// here behave like any real website.
//
//   /page/<name>          a long page titled <name>, with links and a form
//   /slow/<ms>/<name>     the same, after a delay (for "stop loading")
//   /download/<name>      a small file served as an attachment
//   /echo-headers         the request headers as JSON

import http from "node:http";

function page(name, origin) {
  const paragraphs = Array.from({ length: 120 }, (_, i) => `<p id="p${i}">Paragraph ${i} of ${name}. The quick brown fox jumps over the lazy dog.</p>`).join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${name}</title></head>
<body>
<h1 id="top">${name}</h1>
<p><a id="link-other" href="${origin}/page/other">Other page</a>
<a id="link-blank" href="${origin}/page/blank-target" target="_blank">New window link</a>
<a id="link-download" href="${origin}/download/file.txt">Download</a></p>
<form id="form" onsubmit="return false"><input id="text" value=""><input id="password" type="password"></form>
${paragraphs}
<p id="bottom">Bottom of ${name}</p>
</body></html>`;
}

export async function startServer(host = "127.0.0.2") {
  const server = http.createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page(decodeURIComponent(parts[1] || "page"), origin));
    } else if (parts[0] === "slow") {
      await new Promise((r) => setTimeout(r, parseInt(parts[1], 10) || 3000));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(decodeURIComponent(parts[2] || "slow"), origin));
    } else if (parts[0] === "download") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": `attachment; filename="${parts[1] || "file.txt"}"` });
      res.end("Kessel test download\n");
    } else if (parts[0] === "echo-headers") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.headers));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  return { origin: `http://${host}:${port}`, close: () => new Promise((r) => server.close(r)) };
}
