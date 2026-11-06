// Tiny static server for local development. Fills __SITE_URL__ in install.sh with the
// address you're browsing from, so the generated command works against this server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const root = new URL("../public/", import.meta.url).pathname;
const port = Number(process.env.PORT || 3000);
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon", ".tsv": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  let file = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  if (file.endsWith("/")) file += "index.html";
  try {
    let body = await readFile(root + file);
    if (file === "/install.sh") body = body.toString().replaceAll("__SITE_URL__", `http://${req.headers.host}`);
    // no-cache: the browser may keep a copy but must check it is current first, so edits always show up on reload
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "0.0.0.0", () => console.log(`Getem.sh on http://localhost:${port}`));
