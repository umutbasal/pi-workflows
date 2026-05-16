import { watch } from "fs";
import { readFile } from "fs/promises";
import { createServer, type Server, type ServerResponse } from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { listRuns } from "./store";

function getTemplatePath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return join(dir, "..", "assets", "template.html");
}

export function startDashboard(cwd: string, port = 3847): Promise<{ url: string; stop: () => void }> {
  const runsDir = join(cwd, ".pi-workflows/.runs");
  const sseClients = new Set<ServerResponse>();

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(runsDir, () => {
      for (const res of sseClients) {
        res.write("event: runs-updated\ndata: {}\n\n");
      }
    });
  } catch {}

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = await readFile(getTemplatePath(), "utf-8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("Failed to load template");
      }
      return;
    }

    if (url.pathname === "/api/runs") {
      const runs = await listRuns(cwd);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(runs));
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: connected\ndata: {}\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const dashboardUrl = `http://localhost:${actualPort}`;

      resolve({
        url: dashboardUrl,
        stop() {
          watcher?.close();
          for (const res of sseClients) {
            res.end();
          }
          sseClients.clear();
          server.close();
        },
      });
    });

    server.on("error", (err) => {
      watcher?.close();
      reject(err);
    });
  });
}
