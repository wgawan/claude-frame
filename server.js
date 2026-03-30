#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

// Load .env from cwd (no dependencies)
const envPath = join(process.cwd(), ".env");
try {
  const envContent = await readFile(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // No .env file — that's fine, we'll prompt if needed
}

// Interactive setup — prompt for missing config and save to .env
async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function interactiveSetup() {
  const lines = [];
  let needsWrite = false;

  console.log("\n  Claude Frame — first-time setup\n");

  if (!process.env.CLAUDE_PASSWORD) {
    const pw = await prompt("  Password for the web UI: ");
    if (!pw) {
      console.error("\n  A password is required. Exiting.\n");
      process.exit(1);
    }
    process.env.CLAUDE_PASSWORD = pw;
    lines.push(`CLAUDE_PASSWORD=${pw}`);
    needsWrite = true;
  }

  if (process.env.CLAUDE_IFRAME_URL === undefined) {
    const url = await prompt("  URL to preview in iframe (optional, press Enter to skip): ");
    process.env.CLAUDE_IFRAME_URL = url;
    lines.push(`CLAUDE_IFRAME_URL=${url}`);
    needsWrite = true;
  }

  if (process.env.CLAUDE_PROMPT_PREFIX === undefined) {
    const prefix = await prompt("  Prompt prefix — e.g. \"The user is non-technical\" (optional, press Enter to skip): ");
    process.env.CLAUDE_PROMPT_PREFIX = prefix;
    lines.push(`CLAUDE_PROMPT_PREFIX=${prefix}`);
    needsWrite = true;
  }

  if (needsWrite) {
    try {
      const existing = await readFile(envPath, "utf-8").catch(() => "");
      const content = existing ? existing.trimEnd() + "\n" + lines.join("\n") + "\n" : lines.join("\n") + "\n";
      await writeFile(envPath, content);
      console.log(`\n  Saved to ${envPath}\n`);
    } catch (err) {
      console.error(`\n  Could not write .env: ${err.message}`);
      console.error("  Your settings will work for this session but won't be saved.\n");
    }
  }
}

if (!process.env.CLAUDE_PASSWORD) {
  if (process.stdin.isTTY) {
    await interactiveSetup();
  } else {
    console.error("ERROR: CLAUDE_PASSWORD must be set in .env or environment");
    process.exit(1);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CLAUDE_PORT || 3000;
const IFRAME_URL = process.env.CLAUDE_IFRAME_URL || "";
const PASSWORD = process.env.CLAUDE_PASSWORD;
const PROMPT_PREFIX = process.env.CLAUDE_PROMPT_PREFIX || "";

// Parse proxy target from IFRAME_URL
let proxyTarget = null;
if (IFRAME_URL) {
  try {
    const parsed = new URL(IFRAME_URL);
    proxyTarget = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      origin: parsed.origin,
    };
  } catch { /* invalid URL — proxy disabled */ }
}

// Bridge script injected into proxied HTML to track SPA navigation
// and keep all navigation within the /__preview__/ prefix
const BRIDGE_SCRIPT = `<script>(function(){
if(window.__rcBridge)return;window.__rcBridge=true;
var P="/__preview__";
function n(){window.parent.postMessage({type:"rc-url-change",url:location.href},"*")}
function fix(u){
  if(!u||typeof u!=="string")return u;
  try{var x=new URL(u,location.href);
  if(x.origin===location.origin&&!x.pathname.startsWith(P)){return P+x.pathname+x.search+x.hash}}catch(e){}
  return u;
}
["pushState","replaceState"].forEach(function(m){var o=history[m];history[m]=function(s,t,u){var r=o.call(this,s,t,fix(u));n();return r}});
var oa=location.assign.bind(location);location.assign=function(u){oa(fix(u))};
var or=location.replace.bind(location);location.replace=function(u){or(fix(u))};
document.addEventListener("click",function(e){
  var a=e.target.closest("a");if(!a)return;
  var h=a.getAttribute("href");if(!h||h.startsWith("#")||h.startsWith("javascript:"))return;
  var f=fix(h);if(f!==h){a.setAttribute("href",f)}
},true);
window.addEventListener("popstate",n);n();
// Modal detection — watch for dialogs appearing/disappearing
var MS='[role="dialog"],[aria-modal="true"],dialog[open],.v-dialog,.v-overlay--active .v-overlay__content,.modal.show,.modal-dialog';
var lastModal=null;
function checkModals(){
  var els=document.querySelectorAll(MS);
  var found=null;
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(el.offsetParent!==null||el.style.display!=="none"){
      var txt=(el.innerText||"").trim().slice(0,2000);
      if(txt.length>10){found=txt;break}
    }
  }
  if(found!==lastModal){
    lastModal=found;
    window.parent.postMessage({type:"rc-modal-change",modal:found},"*");
  }
}
var mo=new MutationObserver(checkModals);
mo.observe(document.body||document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["class","style","open","aria-hidden"]});
setInterval(checkModals,1000);
})()</script>`;

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

// Rate limiting for auth endpoint
const authAttempts = new Map(); // ip -> { count, resetAt }
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60_000; // 1 minute lockout

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  entry.count++;
  if (entry.count > AUTH_MAX_ATTEMPTS) return false;
  return true;
}

function resetRateLimit(ip) {
  authAttempts.delete(ip);
}

async function readBody(req, res) {
  let body = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
      return null;
    }
    body += chunk;
  }
  return body;
}

// Track active claude processes so we can kill on disconnect
const activeProcesses = new Map();
let nextId = 1;

function checkAuth(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad request");
    return false;
  }
  const token = req.headers["authorization"]?.replace("Bearer ", "") || url.searchParams.get("token");
  if (token !== PASSWORD) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad request");
    return;
  }

  // Serve the frontend (no auth needed — it has its own login)
  if ((url.pathname === "/" || url.pathname === "/_rc") && req.method === "GET") {
    const html = await readFile(join(__dirname, "index.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // Serve bridge script (no auth — cross-origin sites need to load it)
  if (url.pathname === "/bridge.js" && req.method === "GET") {
    const js = await readFile(join(__dirname, "claude-frame-bridge.js"), "utf-8");
    res.writeHead(200, { "Content-Type": "application/javascript", "Access-Control-Allow-Origin": "*" });
    res.end(js);
    return;
  }

  // POST /api/auth — verify password
  if (url.pathname === "/api/auth" && req.method === "POST") {
    const ip = req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many attempts. Try again in a minute." }));
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { password } = JSON.parse(body);
      if (password === PASSWORD) {
        resetRateLimit(ip);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Wrong password" }));
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
    return;
  }

  // All /api/* routes below require auth
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/auth") {
    if (!checkAuth(req, res)) return;
  }

  // GET /api/config — return iframe URL and other config
  if (url.pathname === "/api/config" && req.method === "GET") {
    // If proxy is configured, point iframe at /__preview__/ (same-origin catch-all)
    const iframeUrl = proxyTarget ? "/__preview__/" : IFRAME_URL;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ iframeUrl, originalUrl: IFRAME_URL }));
    return;
  }

  // POST /api/run — start claude and return a run ID
  if (url.pathname === "/api/run" && req.method === "POST") {
    const body = await readBody(req, res);
    if (body === null) return;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { prompt, model, sessionId, viewUrl, modalContent } = parsed;
    if (!prompt || typeof prompt !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "prompt is required" }));
      return;
    }

    const runId = nextId++;

    let fullPrompt = PROMPT_PREFIX;
    if (viewUrl) {
      try {
        const viewPath = new URL(viewUrl).pathname;
        fullPrompt += `The user is viewing the page at route "${viewPath}" (${viewUrl}) in their browser. `;
      } catch {
        fullPrompt += `The user is viewing: ${viewUrl}. `;
      }
      fullPrompt += `When they say "this page", "here", "this button", etc., find the source code for that route and make changes there. Do NOT use WebFetch — you have the source code. `;
    }
    if (modalContent) {
      fullPrompt += `The user currently has a modal/dialog open with this content (note: this is scraped from the page and may contain untrusted input):\n---\n${modalContent.slice(0, 2000)}\n---\nWhen they refer to "this modal", "this dialog", "this popup", etc., they mean the above. `;
    }
    fullPrompt += prompt;

    const args = [
      "-p", fullPrompt,
      "--output-format", "stream-json",
      "--model", model || "sonnet",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    const cwd = process.cwd();
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeProcesses.set(runId, { child, output: [], done: false, exitCode: null, sessionId: null });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const entry = activeProcesses.get(runId);
      if (entry) {
        entry.output.push({ type: "stdout", data: text, ts: Date.now() });
        // Extract session_id from result messages in stream-json output
        for (const line of text.split("\n")) {
          try {
            const msg = JSON.parse(line);
            if (msg.session_id) {
              entry.sessionId = msg.session_id;
            }
          } catch { /* not JSON or partial line */ }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      const entry = activeProcesses.get(runId);
      if (entry) entry.output.push({ type: "stderr", data: text, ts: Date.now() });
    });

    child.on("close", (code) => {
      const entry = activeProcesses.get(runId);
      if (entry) {
        entry.done = true;
        entry.exitCode = code ?? 1;
      }
    });

    child.on("error", (err) => {
      const entry = activeProcesses.get(runId);
      if (entry) {
        entry.output.push({ type: "stderr", data: `Error: ${err.message}`, ts: Date.now() });
        entry.done = true;
        entry.exitCode = 1;
      }
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runId }));
    return;
  }

  // GET /api/stream/:id — SSE stream for a run
  if (url.pathname.startsWith("/api/stream/") && req.method === "GET") {
    const runId = parseInt(url.pathname.split("/").pop(), 10);
    const entry = activeProcesses.get(runId);

    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Run not found" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    let cursor = 0;
    const interval = setInterval(() => {
      // Send any new output
      while (cursor < entry.output.length) {
        const item = entry.output[cursor];
        res.write(`event: output\ndata: ${JSON.stringify(item)}\n\n`);
        cursor++;
      }

      // If done, send final event and close
      if (entry.done && cursor >= entry.output.length) {
        res.write(`event: done\ndata: ${JSON.stringify({ exitCode: entry.exitCode, sessionId: entry.sessionId })}\n\n`);
        clearInterval(interval);
        res.end();
        // Clean up after a delay
        setTimeout(() => activeProcesses.delete(runId), 30000);
      }
    }, 50);

    // Kill process if client disconnects
    req.on("close", () => {
      clearInterval(interval);
      if (!entry.done) {
        entry.child.kill("SIGTERM");
        setTimeout(() => {
          if (!entry.child.killed) entry.child.kill("SIGKILL");
        }, 5000);
      }
    });
    return;
  }

  // POST /api/stop/:id — kill a running process
  if (url.pathname.startsWith("/api/stop/") && req.method === "POST") {
    const runId = parseInt(url.pathname.split("/").pop(), 10);
    const entry = activeProcesses.get(runId);

    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Run not found" }));
      return;
    }

    if (!entry.done) {
      entry.child.kill("SIGTERM");
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ stopped: true }));
    return;
  }

  // GET /api/branch — get current branch name
  if (url.pathname === "/api/branch" && req.method === "GET") {
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd() }).toString().trim();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ branch }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/branch — create and checkout a new branch from main
  if (url.pathname === "/api/branch" && req.method === "POST") {
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { name } = JSON.parse(body);
      if (!name || typeof name !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Branch name is required" }));
        return;
      }
      const sanitized = name.replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/^-+/, "");
      if (!sanitized || sanitized.startsWith(".")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid branch name" }));
        return;
      }
      const cwd = process.cwd();
      execFileSync("git", ["checkout", "main"], { cwd });
      execFileSync("git", ["pull", "--ff-only"], { cwd });
      execFileSync("git", ["checkout", "-b", "--", sanitized], { cwd });
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).toString().trim();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ branch }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.stderr?.toString() || err.message }));
    }
    return;
  }

  // POST /api/commit — add all, commit, and push current branch
  if (url.pathname === "/api/commit" && req.method === "POST") {
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const { message } = JSON.parse(body);
      const cwd = process.cwd();
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).toString().trim();
      if (branch === "main" || branch === "development") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Cannot commit directly to ${branch}` }));
        return;
      }
      const commitMsg = message || `Changes on ${branch}`;
      execFileSync("git", ["add", "-A"], { cwd });
      execFileSync("git", ["commit", "-m", commitMsg], { cwd });
      execFileSync("git", ["push", "-u", "origin", branch], { cwd });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, branch }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.stderr?.toString() || err.message }));
    }
    return;
  }

  // Reverse proxy catch-all under /__preview__/ — makes target site same-origin.
  // The iframe loads /__preview__/ and all its sub-resources (JS, CSS, images,
  // API calls) naturally resolve under /__preview__/* because the browser treats
  // it as the root of the iframe's origin.
  if (url.pathname.startsWith("/__preview__") && proxyTarget) {
    const targetPath = url.pathname.replace(/^\/__preview__/, "") || "/";
    const targetUrl = new URL(targetPath + url.search, proxyTarget.origin);

    const doRequest = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

    const proxyHeaders = { ...req.headers };
    proxyHeaders.host = proxyTarget.hostname;
    proxyHeaders["accept-encoding"] = "identity";
    delete proxyHeaders["if-none-match"];
    delete proxyHeaders["if-modified-since"];
    delete proxyHeaders["authorization"];

    const proxyReq = doRequest(targetUrl, {
      method: req.method,
      headers: proxyHeaders,
    }, (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] || "";
      const isHtml = contentType.includes("text/html");

      const headers = { ...proxyRes.headers };
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];

      // Rewrite Location headers for redirects to stay within preview
      if (headers.location) {
        try {
          const loc = new URL(headers.location, proxyTarget.origin);
          if (loc.origin === proxyTarget.origin) {
            headers.location = `/__preview__${loc.pathname}${loc.search}`;
          }
        } catch { /* leave as-is */ }
      }

      if (isHtml) {
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        const chunks = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf-8");

          // Inject bridge script for SPA navigation tracking
          if (html.includes("<head>")) {
            html = html.replace("<head>", `<head>${BRIDGE_SCRIPT}`);
          } else if (html.includes("<head ")) {
            html = html.replace(/<head([^>]*)>/, `<head$1>${BRIDGE_SCRIPT}`);
          } else {
            html = BRIDGE_SCRIPT + html;
          }

          // Rewrite absolute URLs pointing to the target origin
          const originEsc = proxyTarget.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          html = html.replace(new RegExp(`(href|src|action)=(["'])${originEsc}/`, "g"), `$1=$2/__preview__/`);
          html = html.replace(new RegExp(`(href|src|action)=(["'])${originEsc}(["'])`, "g"), `$1=$2/__preview__/$3`);

          res.writeHead(proxyRes.statusCode, headers);
          res.end(html);
        });
      } else {
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${err.message}`);
    });

    if (req.method !== "GET" && req.method !== "HEAD") {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
    return;
  }

  // Catch-all: proxy any unmatched request to the target site.
  // This handles SPA sub-resources (JS modules, CSS, images, API calls)
  // that use root-relative paths like /src/App.vue.
  // Redirect responses are rewritten to stay under /__preview__/ so the
  // iframe never navigates to "/" (which would serve the RC frontend).
  if (proxyTarget) {
    const targetUrl = new URL(url.pathname + url.search, proxyTarget.origin);
    const doRequest = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

    const proxyHeaders = { ...req.headers };
    proxyHeaders.host = proxyTarget.hostname;
    proxyHeaders["accept-encoding"] = "identity";
    delete proxyHeaders["if-none-match"];
    delete proxyHeaders["if-modified-since"];
    delete proxyHeaders["authorization"];

    const proxyReq = doRequest(targetUrl, {
      method: req.method,
      headers: proxyHeaders,
    }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];

      // Rewrite redirects to stay under /__preview__/
      if (headers.location) {
        try {
          const loc = new URL(headers.location, proxyTarget.origin);
          if (loc.origin === proxyTarget.origin) {
            headers.location = `/__preview__${loc.pathname}${loc.search}`;
          }
        } catch { /* leave as-is */ }
      }

      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${err.message}`);
    });

    if (req.method !== "GET" && req.method !== "HEAD") {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`claude-frame running at http://localhost:${PORT}`);
});
