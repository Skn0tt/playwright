import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { join, extname, dirname } from "node:path"
import { fileURLToPath } from "node:url"
const root = join(dirname(fileURLToPath(import.meta.url)), "public")
const types = { ".html": "text/html; charset=utf-8" }
createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname
  const file = join(root, path === "/" ? "index.html" : path)
  try {
    const body = await readFile(file)
    res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain" })
    res.end(body)
  } catch {
    res.writeHead(404); res.end("not found")
  }
}).listen(3123)
