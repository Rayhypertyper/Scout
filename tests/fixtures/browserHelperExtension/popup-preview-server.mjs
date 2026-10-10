import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(process.env.SCOUT_PROJECT_ROOT || process.cwd());
const extensionRoot = resolve(projectRoot, "extension");
const previewShim = resolve(projectRoot, "tests/fixtures/browserHelperExtension/popup-preview-chrome.js");
const port = Number(process.env.SCOUT_POPUP_PREVIEW_PORT || 43872);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/" || url.pathname === "/popup.html") {
    try {
      const html = await readFile(resolve(extensionRoot, "popup.html"), "utf8");
      const withPreviewShim = html.replace("<body>", '<body>\n    <script src="/preview-chrome.js"></script>');
      response.writeHead(200, { "Content-Type": contentTypes[".html"], "Cache-Control": "no-store" });
      response.end(withPreviewShim);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Could not load extension/popup.html from the project root.");
    }
    return;
  }
  if (url.pathname === "/preview-chrome.js") {
    try {
      response.writeHead(200, { "Content-Type": contentTypes[".js"], "Cache-Control": "no-store" });
      response.end(await readFile(previewShim));
    } catch {
      response.writeHead(404);
      response.end();
    }
    return;
  }

  const relativePath = decodeURIComponent(url.pathname.slice(1));
  const filePath = resolve(extensionRoot, relativePath);
  if (filePath !== extensionRoot && !filePath.startsWith(`${extensionRoot}${sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(contents);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Scout popup preview: http://127.0.0.1:${port}/popup.html\n`);
  process.stdout.write("Mocked browser storage only. ATS page access and Scout sync are disabled.\n");
});

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}
