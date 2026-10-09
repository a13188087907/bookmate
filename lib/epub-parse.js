import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * EPUB 解析器。解析核心是 Python 脚本（scripts/parse_epub.py），
 * 复用成熟的标准库（zipfile + HTMLParser），零第三方依赖。
 * Node 侧只负责 spawn 子进程与结果约定。
 */
export class PythonParser {
  constructor({ command, log }) {
    this.command = command;
    this.log = log;
    this.script = path.join(__dirname, "..", "scripts", "parse_epub.py");
  }

  async parse(epubPath, outDir) {
    const result = await runPython(this.command, [this.script, epubPath, outDir], this.log);
    if (!result.ok) {
      throw new Error(`EPUB 解析失败：${result.stderr || result.error}`);
    }
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const meta = JSON.parse(lines[lines.length - 1]);
    return meta;
  }
}

function runPython(command, args, log) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch (err) {
      resolve({ ok: false, error: err.message, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else {
        resolve({ ok: false, error: `exit code ${code}`, stdout, stderr });
      }
    });
  });
}
