/**
 * Deploy static site lên Surge.sh
 * - Token/login CHỈ từ env, không log, không trả về Discord
 * - Chỉ trả URL khi verify HTTP live (không còn "project not found")
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Chặn lộ credential trong mọi string trả ra ngoài */
export function redactSecrets(text) {
  let s = String(text || "");
  const secrets = [config.surge?.token, config.surge?.login, process.env.SURGE_TOKEN, process.env.SURGE_LOGIN].filter(
    Boolean
  );
  for (const sec of secrets) {
    if (sec && s.includes(sec)) s = s.split(sec).join("[REDACTED]");
  }
  s = s.replace(/cfut_[A-Za-z0-9]+/g, "[REDACTED]");
  s = s.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]");
  return s;
}

function randomSubdomain() {
  const a = randomBytes(3).toString("hex");
  const b = Date.now().toString(36).slice(-5);
  return `gx${a}${b}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
}

function safeRelPath(p) {
  const n = String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\0/g, "");
  if (!n || n.includes("..") || path.isAbsolute(n)) return null;
  if (!/^[a-zA-Z0-9._\-/]+$/.test(n)) return null;
  return n;
}

async function writeSiteFiles(dir, { html, files = [], domain }) {
  let index = String(html || "").trim();
  if (!index) throw new Error("html rỗng — cần nội dung index.html");
  if (index.length > 900_000) throw new Error("HTML quá lớn (>900KB)");

  if (!/<html[\s>]/i.test(index) && !/<!DOCTYPE/i.test(index)) {
    index = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site</title></head><body>${index}</body></html>`;
  }
  if (!/<\/html>/i.test(index)) index += "\n</html>";

  await fs.writeFile(path.join(dir, "index.html"), index, "utf8");
  // CNAME giúp surge bind đúng domain
  if (domain) {
    await fs.writeFile(path.join(dir, "CNAME"), domain.replace(/^https?:\/\//, ""), "utf8");
  }

  const extras = Array.isArray(files) ? files.slice(0, 20) : [];
  for (const f of extras) {
    const rel = safeRelPath(f.path || f.name);
    if (!rel || rel === "index.html" || rel === "CNAME") continue;
    const content = String(f.content ?? "");
    if (content.length > 400_000) continue;
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
}

function isSurgeSuccess(code, out) {
  // fail cứng
  if (/Unauthorized|Login required|Invalid token|Invalid credentials/i.test(out)) return false;
  if (/Aborted|Deployment not initiated/i.test(out)) return false;
  if (/ENOENT|Cannot find module/i.test(out)) return false;

  // Surge CLI thường exit 0 + in bảng Certificate / domain (không luôn có chữ "Success!")
  if (code === 0 && (/Certificate:|domain:|Success!\s*Project is published|published/i.test(out))) {
    return true;
  }
  if (/Success!\s*Project is published/i.test(out)) return true;
  return false;
}

function parsePublishedUrl(out, fallbackUrl) {
  const m = String(out).match(/https?:\/\/([a-z0-9-]+\.surge\.sh)/i);
  if (m) return `https://${m[1].toLowerCase()}`;
  return fallbackUrl;
}

function runSurge(dir, domain) {
  const login = config.surge.login;
  const token = config.surge.token;
  if (!login || !token) {
    return Promise.reject(new Error("Thiếu SURGE_LOGIN hoặc SURGE_TOKEN trong env"));
  }

  const surgeBin = path.join(PROJECT_ROOT, "node_modules", "surge", "bin", "surge");
  // node bin/surge <project> <domain>
  const args = [surgeBin, dir, domain];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        SURGE_LOGIN: login,
        SURGE_TOKEN: token,
        CI: "true",
        FORCE_COLOR: "0",
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error("Surge deploy timeout (90s)"));
    }, 90_000);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(redactSecrets(err.message)));
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const out = redactSecrets(`${stdout}\n${stderr}`);
      if (isSurgeSuccess(code, out)) {
        resolve({ ok: true, log: out.slice(0, 800), code });
        return;
      }
      reject(
        new Error(
          redactSecrets(
            `Surge fail (exit ${code}). ${out.replace(/\s+/g, " ").trim().slice(0, 280) || "no output — check SURGE_LOGIN/TOKEN & package surge"}`
          )
        )
      );
    });
  });
}

/** Poll URL đến khi không còn "project not found" */
async function waitUntilLive(url, { tries = 15, delayMs = 1200 } = {}) {
  let lastSnippet = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "discord-ai-modbot-surge-check/1.0", Accept: "text/html" },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      lastSnippet = text.slice(0, 120).replace(/\s+/g, " ");
      const dead =
        /project not found/i.test(text) ||
        /project not found/i.test(lastSnippet) ||
        (res.status === 404 && text.length < 2000);

      if (res.ok && !dead && text.length > 80 && /<html|<!DOCTYPE/i.test(text)) {
        return { live: true, status: res.status };
      }
    } catch (e) {
      lastSnippet = e.message || "fetch error";
    }
    await sleep(delayMs);
  }
  return { live: false, lastSnippet: redactSecrets(lastSnippet) };
}

async function rmDirSafe(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{ url: string, domain: string }}
 */
export async function deployToSurge({ html, files = [], subdomain } = {}) {
  let slug = String(subdomain || randomSubdomain())
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (slug.length < 3) slug = randomSubdomain();

  const domain = `${slug}.surge.sh`;
  let url = `https://${domain}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "surge-site-"));

  try {
    await writeSiteFiles(tmp, { html, files, domain });
    console.log(`[surge] deploying → ${domain}`);
    const result = await runSurge(tmp, domain);
    url = parsePublishedUrl(result.log, url);
    console.log(`[surge] cli ok, verifying ${url} …`);

    const check = await waitUntilLive(url);
    if (!check.live) {
      // retry deploy 1 lần cùng domain
      console.log(`[surge] not live yet, retry publish once…`);
      await runSurge(tmp, domain);
      const check2 = await waitUntilLive(url, { tries: 12, delayMs: 1500 });
      if (!check2.live) {
        throw new Error(
          `Deploy xong CLI nhưng site vẫn "project not found" (${url}). Token/account Surge có thể sai hoặc domain chưa publish. snippet=${check2.lastSnippet || check.lastSnippet}`
        );
      }
    }

    console.log(`[surge] LIVE ${url}`);
    return { url, domain: url.replace(/^https?:\/\//, "") };
  } finally {
    await rmDirSafe(tmp);
  }
}
