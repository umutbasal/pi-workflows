import { watch } from "fs";
import { readFile } from "fs/promises";
import { createServer, type Server, type ServerResponse } from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { listRuns, loadRun } from "./store";
import { parseSessionFile, findSessionById, listSessionsForProject, getSessionStatsForRun } from "./sessions";

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

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch) {
      const runId = runMatch[1];
      const run = await loadRun(cwd, runId);
      if (!run) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(run));
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/session$/);
    if (sessionMatch) {
      const runId = sessionMatch[1];
      const run = await loadRun(cwd, runId);
      if (!run) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
        return;
      }
      const sessionStats = await getSessionStatsForRun(run.steps);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessionStats));
      return;
    }

    const sessionFileMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionFileMatch) {
      const sessionId = decodeURIComponent(sessionFileMatch[1]);
      const filePath = await findSessionById(sessionId);
      if (!filePath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      const stats = await parseSessionFile(filePath);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    if (url.pathname === "/api/project-sessions") {
      const sessions = await listSessionsForProject(cwd);
      const sessionList = [];
      for (const filePath of sessions.slice(0, 50)) {
        const stats = await parseSessionFile(filePath);
        if (stats) {
          sessionList.push({
            id: stats.id,
            createdAt: stats.createdAt,
            cwd: stats.cwd,
            totalMessages: stats.totalMessages,
            totalTokens: stats.totalTokens,
            totalCost: stats.totalCost,
            models: stats.models.map(m => ({ model: m.model, provider: m.provider })),
          });
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessionList));
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
