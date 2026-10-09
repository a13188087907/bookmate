/**
 * 阶段 2：Markdown 导出。
 *
 * 组装《书名》.md：
 *   frontmatter（title / author / importedAt / exportedAt / 进度）
 *   章节骨架表、我的立场演变、按章分组划线、复盘问答（review.json 存在时）。
 *
 * 输出目标是生活外脑 raw/阅读 目录，raw → wiki 流程可直接消化：
 * 用纯 Markdown 结构（表格/引用/列表），不带 HTML。
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * 导出整本书为 Markdown 文件。
 * @param {object} runtime ctx._bookmate（store / log）
 * @param {string} bookId
 * @param {string} targetDir 导出目录（已由用户配置或页面选择授权）
 * @returns {Promise<string>} 落盘文件绝对路径（重复导出覆盖同名）
 */
export async function exportBookMarkdown(runtime, bookId, targetDir) {
  const { store } = runtime;
  const meta = await store.getMeta(bookId);
  if (!meta) throw new Error("书籍不存在");

  const [chapters, progress, skeleton, highlights, review] = await Promise.all([
    store.getChapters(bookId),
    store.getProgress(bookId),
    store.getSkeleton(bookId),
    store.getHighlights(bookId),
    readJsonSafe(path.join(store.bookDir(bookId), "review.json")),
  ]);

  const md = buildMarkdown({ meta, chapters, progress, skeleton, highlights, review });

  const safeTitle = String(meta.title ?? "未命名")
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .trim() || "未命名";
  const filePath = path.join(targetDir, `《${safeTitle}》.md`);
  // v2：写 dataDir 外路径走宿主 ResourceIO（app/resources.write 授权），父目录由 provider 自动创建
  await runtime.resources.write({ kind: "local-file", path: filePath }, md);
  return filePath;
}

/* ---------- 组装 ---------- */

function buildMarkdown({ meta, chapters, progress, skeleton, highlights, review }) {
  const exportedAt = new Date().toISOString();
  const total = chapters.length;
  const currentIdx = Math.min(Math.max(0, Number(progress?.chapter ?? 0)), Math.max(0, total - 1));
  const readCount = total > 0 ? Math.min(currentIdx + 1, total) : 0;
  const percent = total > 0 ? Math.round((readCount / total) * 100) : 0;

  const lines = [];
  lines.push("---");
  lines.push(`title: ${String(meta.title ?? "未命名")}`);
  lines.push(`author: ${String(meta.author ?? "未知")}`);
  lines.push(`importedAt: ${String(meta.importedAt ?? "")}`);
  lines.push(`exportedAt: ${exportedAt}`);
  lines.push(`progress: 第 ${readCount}/${total} 章（${percent}%）`);
  lines.push("---");
  lines.push("");
  lines.push(`# 《${String(meta.title ?? "未命名")}》`);
  lines.push("");

  lines.push(...buildSkeletonSection(skeleton, chapters));
  lines.push(...buildStanceSection(skeleton, chapters));
  lines.push(...buildHighlightSection(highlights, chapters));
  lines.push(...buildReviewSection(review));
  lines.push("");

  return lines.join("\n");
}

/** ## 章节骨架（表格：章节 | 主题 | 关键概念） */
function buildSkeletonSection(skeleton, chapters) {
  const out = ["## 章节骨架", ""];
  const notes = skeleton?.chapters ?? [];
  if (!notes.length) {
    out.push("（尚未沉淀任何章节笔记——阅读时点击「沉淀」生成）", "");
    return out;
  }
  out.push("| 章节 | 主题 | 关键概念 |", "| --- | --- | --- |");
  for (const note of notes) {
    const title = chapterTitleAt(chapters, note.idx, note.title);
    const theme = String(note.theme ?? "").replace(/\|/g, "\\|") || "—";
    const concepts = Array.isArray(note.keyConcepts)
      ? note.keyConcepts.map((c) => String(c).replace(/\|/g, "\\|")).join("、")
      : "—";
    out.push(`| 第${Number(note.idx) + 1}章 ${escapeCell(title)} | ${theme} | ${concepts || "—"} |`);
  }
  out.push("");
  return out;
}

/** ## 我的立场演变（readerStance + 各章 readerPositions） */
function buildStanceSection(skeleton, chapters) {
  const out = ["## 我的立场演变", ""];
  const stance = String(skeleton?.readerStance ?? "").trim();
  if (stance) out.push(`**全书立场摘要**：${stance}`, "");
  const notes = skeleton?.chapters ?? [];
  const withPos = notes.filter((n) => Array.isArray(n.readerPositions) && n.readerPositions.length);
  if (!withPos.length) {
    out.push("（暂无记录——对话中表达过立场后，随「沉淀」累积到这里）", "");
    return out;
  }
  out.push("| 章节 | 我表达过的立场 |", "| --- | --- |");
  for (const note of withPos) {
    const title = chapterTitleAt(chapters, note.idx, note.title);
    const pos = note.readerPositions.map((p) => String(p).replace(/\|/g, "\\|")).join("；");
    out.push(`| 第${Number(note.idx) + 1}章 ${escapeCell(title)} | ${pos} |`);
  }
  out.push("");
  return out;
}

/** ## 划线（按章分组，附段落原文） */
function buildHighlightSection(highlights, chapters) {
  const out = ["## 划线", ""];
  const list = Array.isArray(highlights) ? highlights : [];
  if (!list.length) {
    out.push("（暂无划线——阅读中选中文字即可划线）", "");
    return out;
  }
  const byChapter = new Map();
  for (const hl of list) {
    const key = Number(hl.chapter ?? 0);
    if (!byChapter.has(key)) byChapter.set(key, []);
    byChapter.get(key).push(hl);
  }
  for (const [idx, group] of [...byChapter.entries()].sort((a, b) => a[0] - b[0])) {
    const ch = chapters[idx];
    const title = ch?.title ? `第${idx + 1}章「${ch.title}」` : `第${idx + 1}章`;
    out.push(`### ${title}`, "");
    for (const hl of group) {
      const text = String(hl.text ?? "").trim();
      if (text) out.push(`> ${text}`, "");
    }
  }
  return out;
}

/** ## 复盘问答（review.json 存在时；本阶段可能不存在 → 整节省略） */
function buildReviewSection(review) {
  if (!review || typeof review !== "object") return [];
  const qas = Array.isArray(review.qa) ? review.qa : Array.isArray(review.questions) ? review.questions : [];
  if (!qas.length) return [];
  const out = ["## 复盘问答", ""];
  for (const item of qas) {
    const q = String(item.q ?? item.question ?? "").trim();
    const a = String(item.a ?? item.answer ?? "").trim();
    if (!q) continue;
    out.push(`**问**：${q}`, "");
    if (a) out.push(`${a}`, "");
  }
  return out;
}

/* ---------- 内部工具 ---------- */

function chapterTitleAt(chapters, idx, fallback) {
  try {
    return chapters?.[Number(idx)]?.title || String(fallback ?? "");
  } catch {
    return String(fallback ?? "");
  }
}

function escapeCell(text) {
  return String(text ?? "").replace(/\|/g, "\\|");
}

/** 读 JSON 文件，不存在/损坏返回 null（review.json 本阶段可能没有） */
async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
