// 书友 v2 入口：书库/解析器/会话伴侣初始化 + 两个 Agent 工具 + 专用人格 agent 确保存在。
// 后端 API 走 routes/api.js（兼容目录，宿主自动挂载）；阅读页是 ui/reader.html（整页卡片静态树）。

import { defineApp } from "./sdk/app-contract/server-client.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { BookStore } from "./lib/store-v3.js";
import { PythonParser } from "./lib/epub-parse.js";
import { exportBookMarkdown } from "./lib/export.js";
import { setRuntime, requireRuntime } from "./src/runtime.js";

export const name = "bookmate";

async function readConfig(ctx, key, fallback) {
  try {
    const value = await ctx.config?.get?.(key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function describeRef(ref) {
  if (!ref) return "未知文件";
  if (ref.path) return path.basename(ref.path);
  if (ref.fileId) return String(ref.fileId).slice(0, 24);
  return "未知文件";
}

async function importOne(runtime, ref) {
  const { store, parser, resources } = runtime;
  let localPath;
  try {
    const materialized = await resources.materialize(ref);
    localPath = materialized?.filePath;
  } catch (err) {
    return { ok: false, label: describeRef(ref), error: `无法读取文件：${err.message}` };
  }
  if (!localPath) {
    return { ok: false, label: describeRef(ref), error: "无法定位 EPUB 文件路径" };
  }

  const bookId = `book_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const workDir = path.join(store.bookDir(bookId), "parse_tmp");
  try {
    await fsp.mkdir(workDir, { recursive: true });
    const meta = await parser.parse(localPath, workDir);
    if (meta.chapterCount === 0) {
      return { ok: false, label: path.basename(localPath), error: "没有提取到任何章节，可能是图片型 EPUB 或结构异常" };
    }
    const chapters = JSON.parse(await fsp.readFile(path.join(workDir, "chapters.json"), "utf8"));
    await store.createBook({ id: bookId, title: meta.title, author: meta.author, chapters });
    // 迁移插图到书目录（随书持久化）
    try {
      await fsp.cp(path.join(workDir, "images"), path.join(store.bookDir(bookId), "images"), { recursive: true });
    } catch {}
    await fsp.rm(workDir, { recursive: true, force: true });
    return { ok: true, bookId, title: meta.title, author: meta.author, chapterCount: meta.chapterCount };
  } catch (err) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, label: path.basename(localPath), error: err.message };
  }
}

export default defineApp(async (sdk) => {
  fs.mkdirSync(sdk.dataDir, { recursive: true });

  const store = new BookStore({ dataDir: sdk.dataDir });
  await store.init();

  const parser = new PythonParser({
    command: await readConfig(sdk, "pythonCommand", "python"),
    log: sdk.logger,
  });

  const runtime = {
    store,
    parser,
    bus: sdk.bus ?? null,
    pluginId: "bookmate",
    log: sdk.logger,
    config: sdk.config ?? null,
    models: sdk.models ?? null,
    resources: sdk.resources ?? null,
  };
  setRuntime(runtime);

  await sdk.tools.register({
    name: "import-epub",
    description: "导入 EPUB 电子书（支持批量），解析章节后加入书友书库。",
    parameters: {
      type: "object",
      properties: {
        book: {
          type: "object",
          description: "EPUB 文件引用（单本），例如 { kind: 'local-file', path } 或 { kind: 'session-file', fileId }。",
        },
        books: {
          type: "array",
          items: {
            type: "object",
            description: "EPUB 文件引用（批量），例如 { kind: 'local-file', path } 或 { kind: 'session-file', fileId }。",
          },
          description: "多本 EPUB 文件引用，一次批量导入。",
        },
      },
    },
    execute: async (input = {}) => {
      const rt = requireRuntime();
      const refs = [input.book, ...(Array.isArray(input.books) ? input.books : [])].filter(Boolean);
      if (refs.length === 0) {
        return { content: [{ type: "text", text: "请提供 EPUB 文件（book 或 books 参数）。" }] };
      }
      const results = [];
      for (const ref of refs) {
        results.push(await importOne(rt, ref));
      }
      const ok = results.filter((r) => r.ok);
      const fail = results.filter((r) => !r.ok);
      const lines = [
        ok.length ? `成功导入 ${ok.length} 本：${ok.map((r) => `《${r.title}》`).join("、")}` : null,
        fail.length ? `失败 ${fail.length} 本：${fail.map((r) => `${r.label}（${r.error}）`).join("、")}` : null,
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") || "没有导入任何书籍。" }],
        details: {
          imported: ok.map((r) => ({ bookId: r.bookId, title: r.title, author: r.author, chapterCount: r.chapterCount })),
          failed: fail.map((r) => ({ label: r.label, error: r.error })),
        },
      };
    },
  });

  await sdk.tools.register({
    name: "export-book",
    description:
      "把一本书导出为 Markdown（章节骨架、我的立场演变、按章分组划线、复盘问答），写入应用设置中的「导出目录」（exportDir）。",
    parameters: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID（书库列表中的 id 字段，形如 book_xxx）。" },
      },
      required: ["bookId"],
    },
    execute: async (input = {}) => {
      const rt = requireRuntime();
      const bookId = String(input.bookId ?? "").trim();
      if (!bookId) {
        return { content: [{ type: "text", text: "请提供 bookId。可用书库列表获取书籍 ID。" }] };
      }
      const exportDir = await readConfig(sdk, "exportDir", null);
      if (!exportDir) {
        return {
          content: [{ type: "text", text: "尚未配置导出目录：请先在应用设置中填写「导出目录」（exportDir）。" }],
        };
      }
      try {
        const filePath = await exportBookMarkdown(rt, bookId, exportDir);
        return {
          content: [{ type: "text", text: `已导出《${String(filePath).split(/[\\/]/).pop()}》→ ${filePath}` }],
          details: { bookId, path: filePath },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `导出失败：${err.message}` }] };
      }
    },
  });

  await sdk.logger.info("bookmate v2 loaded").catch(() => {});
});
