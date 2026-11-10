import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const requested = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, requested === "/" ? "index.html" : requested);
  try {
    if (!(await stat(file)).isFile()) file = join(root, "index.html");
  } catch {
    file = join(root, "index.html");
  }
  response.setHeader("content-type", contentTypes.get(extname(file)) ?? "application/octet-stream");
  response.setHeader(
    "cache-control",
    file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  );
  response.setHeader("x-content-type-options", "nosniff");
  createReadStream(file).pipe(response);
}).listen(4173, "0.0.0.0");
