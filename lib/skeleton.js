/**
 * 书骨架（阶段 1）。
 *
 * 数据落在 store 的 skeleton.json：
 *   { chapters: [{ idx, title, theme, keyConcepts[], readerPositions[], openQuestions[], updatedAt }],
 *     readerStance: "跨章节累积的读者立场摘要（≤200 字）" }
 *
 * 生成 = 章节正文节选（~3000 字）+ 该书会话近期对话 → model:sample-text 结构化 JSON。
 * 骨架生成失败只影响本章笔记，不影响阅读与对话；可手动「沉淀本章」重试。
 */

const CHAPTER_EXCERPT_CHARS = 3000; // 正文节选上限
const STANCE_MAX_CHARS = 200; // readerStance 长度上限
const CONTEXT_MAX_CHARS = 600; // buildSkeletonContext 注入文本上限

/**
 * 生成一章的结构化笔记并写入 skeleton，同时滚动更新 readerStance。
 * @param {object} runtime ctx._bookmate（store / bus / pluginId / log）
 * @param {string} bookId
 * @param {number} chapterIdx
 * @param {{ force?: boolean }} options force=true 时覆盖本章已有笔记（手动沉淀）
 * @returns {Promise<object|null>} 笔记对象；章节不存在返回 null
 */
export async function generateChapterNote(runtime, bookId, chapterIdx, options = {}) {
  const { store, log } = runtime;
  const chapter = await store.getChapter(bookId, chapterIdx);
  if (!chapter) return null;
  const meta = await store.getMeta(bookId);

  const skeleton = await store.getSkeleton(bookId);
  const existing = (skeleton.chapters ?? []).find((c) => Number(c.idx) === Number(chapterIdx));
  if (existing && !options.force) return existing;

  const bookTitle = meta?.title ?? "未知书";
  const chapterText = chapter.paragraphs.join("\n").slice(0, CHAPTER_EXCERPT_CHARS);
  const dialog =
    Array.isArray(options.dialog) && options.dialog.length
      ? options.dialog
      : await fetchChapterDialog(runtime, bookId);

  const raw = await callModel(
    runtime,
    buildNotePrompt({ bookTitle, chapter, chapterText, dialog, skeleton }),
  );
  const note = parseModelJson(raw, {
    idx: Number(chapterIdx),
    title: chapter.title,
    updatedAt: new Date().toISOString(),
  });

  // 立场摘要滚动更新：失败不阻断本章笔记落盘，保留旧值
  const readerStance = await updateReaderStance(runtime, { bookTitle, skeleton, note });

  const chapters = (skeleton.chapters ?? []).filter((c) => Number(c.idx) !== Number(chapterIdx));
  chapters.push(note);
  chapters.sort((a, b) => Number(a.idx) - Number(b.idx));
  await store.saveSkeleton(bookId, { chapters, readerStance });
  log?.info?.(`skeleton note saved: ${bookId} ch${chapterIdx}`);
  return note;
}

/**
 * 把骨架压缩成 ≤600 字的前情注入文本。骨架为空时返回 null（不注入）。
 * 章节多时逐级收窄：先砍立场细节 → 再砍遗留问题 → 只留最近 8 章。
 */
export function buildSkeletonContext(skeleton) {
  const chapters = skeleton?.chapters ?? [];
  const stance = String(skeleton?.readerStance ?? "").trim();
  if (!chapters.length && !stance) return null;

  const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  const buildLines = (list, opts) =>
    list.map((ch) => {
      const parts = [`第${Number(ch.idx) + 1}章《${flat(ch.title)}》：${flat(ch.theme) || "无主题"}`];
      const pos = ch.readerPositions ?? [];
      if (pos.length) parts.push(`立场：${opts.fullPos ? pos.map(flat).join("；") : flat(pos[0])}`);
      const qs = ch.openQuestions ?? [];
      if (opts.questions && qs.length) parts.push(`待问：${qs.slice(0, 2).map(flat).join("；")}`);
      return parts.join("｜");
    });

  const stanceBlock = stance ? `你的立场演变：${stance}` : "";
  const bodyOf = (lines) => lines.join("\n");

  // 逐级收窄，直到 正文 + 立场 ≤ CONTEXT_MAX_CHARS
  let opts = { fullPos: true, questions: true };
  let lines = buildLines(chapters, opts);
  for (const tighter of [
    { fullPos: false, questions: true },
    { fullPos: false, questions: false },
  ]) {
    if (bodyOf(lines).length + stanceBlock.length <= CONTEXT_MAX_CHARS) break;
    opts = tighter;
    lines = buildLines(chapters, opts);
  }
  if (bodyOf(lines).length + stanceBlock.length > CONTEXT_MAX_CHARS && chapters.length > 8) {
    lines = buildLines(chapters.slice(-8), { fullPos: false, questions: false });
  }

  const out = ["【全书骨架】", bodyOf(lines), stanceBlock].filter(Boolean).join("\n");
  return out.length > CONTEXT_MAX_CHARS ? out.slice(0, CONTEXT_MAX_CHARS) : out;
}

/* ---------- 内部实现 ---------- */

/** 取该书所有助手会话的近期对话（session:history，每会话最多 16 条，共 ≤30 条）。取不到返回空数组。 */
async function fetchChapterDialog(runtime, bookId) {
  const companion = runtime.companion;
  if (!companion || typeof runtime.bus?.request !== "function") return [];
  const sessions = companion.sessions?.[bookId] ?? {};
  const paths = Object.values(sessions).filter(Boolean);
  const out = [];
  for (const sessionPath of paths.slice(0, 3)) {
    try {
      const hist = await runtime.bus.request("session:history", { sessionPath, limit: 40 });
      const msgs = (hist?.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
      for (const m of msgs.slice(-16)) {
        const content = String(m.content ?? "").trim();
        if (!content) continue;
        out.push({ role: m.role === "assistant" ? "书友" : "读者", content: content.slice(0, 400) });
      }
    } catch {
      // 单个会话取不到不阻断
    }
  }
  return out.slice(-30);
}

/** 生成本章笔记的 prompt */
function buildNotePrompt({ bookTitle, chapter, chapterText, dialog, skeleton }) {
  const dialogBlock = dialog.length
    ? dialog.map((d) => `${d.role}：${d.content}`).join("\n")
    : "（该书暂无对话记录，仅依据正文）";
  const oldStance = skeleton?.readerStance ? `旧立场摘要：${skeleton.readerStance}` : "（暂无）";
  return [
    "你是阅读笔记整理助手。把一章正文和读者对话整理成结构化骨架，输出严格 JSON。",
    "",
    `【书】《${bookTitle}》`,
    `【章节】第 ${Number(chapter.idx) + 1} 章「${chapter.title}」`,
    "【正文节选（最多 3000 字）】",
    chapterText,
    "",
    "【该书近期对话（读者与书友，可能含其他章节，只提炼与本章相关的内容）】",
    dialogBlock,
    "",
    `【全书读者立场摘要（旧，供参考）】${oldStance}`,
    "",
    "输出 JSON（不要代码块、不要任何其他文字）：",
    "{",
    `  "idx": ${Number(chapter.idx)},`,
    '  "title": "章节名",',
    '  "theme": "本章主题，一句话 ≤40 字",',
    '  "keyConcepts": ["3-5 个关键概念"],',
    '  "readerPositions": ["读者表达过的立场/判断，0-5 条，每条 ≤40 字；没有就空数组"],',
    '  "openQuestions": ["遗留的值得后文追问的问题，1-3 条；没有就空数组"]',
    "}",
  ].join("\n");
}

/** 基于旧立场 + 新章笔记，滚动生成 ≤200 字的全书立场摘要 */
async function updateReaderStance(runtime, { bookTitle, skeleton, note }) {
  const old = String(skeleton?.readerStance ?? "").trim();
  const positions = note.readerPositions ?? [];
  if (!positions.length && !old) return old;
  try {
    const prompt = [
      "你是阅读笔记整理助手。基于读者旧立场摘要和新一章的笔记，输出更新后的全书读者立场摘要。",
      "要求：中文一段话，≤200 字，只输出摘要本身，不要任何其他文字。",
      "",
      `【书】《${bookTitle}》`,
      `【旧立场摘要】${old || "（无）"}`,
      `【新章「${note.title}」】主题：${note.theme}`,
      `本章读者立场：${positions.join("；") || "（本章无）"}`,
      "",
      "更新后的读者立场摘要：",
    ].join("\n");
    const raw = await callModel(runtime, prompt);
    const stance = String(raw ?? "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .slice(0, STANCE_MAX_CHARS);
    return stance || old;
  } catch (err) {
    runtime.log?.warn?.(`readerStance update failed: ${err.message}`);
    return old;
  }
}

/**
 * 宿主模型调用：bus 事件 model:sample-text（与 routes/api.js 同款通道）。
 * 骨架生成要求结构化输出，temperature 取低值。
 */
async function callModel(runtime, prompt) {
  if (typeof runtime.models?.utility !== "function") {
    throw new Error("宿主模型通道不可用");
  }
  const result = await runtime.models.utility({
    requestId: `bookmate-skel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    systemPrompt: String(prompt).split("\n\n")[0],
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });
  return result?.text ?? "";
}

/** 容错解析模型输出的 JSON：剥代码块、取第一个 { 到最后一个 }，字段逐项兜底 */
function parseModelJson(raw, fallback) {
  let text = String(raw ?? "").trim();
  text = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("模型输出不含 JSON");
  let obj;
  try {
    obj = JSON.parse(text.slice(first, last + 1));
  } catch (err) {
    throw new Error(`模型输出 JSON 解析失败：${err.message}`);
  }
  const note = {
    // idx 是程序侧参数，以请求为准，不信任模型输出（防幻觉导致章节错位）
    idx: Number(fallback.idx),
    title: String(obj.title ?? fallback.title ?? "").slice(0, 200),
    theme: String(obj.theme ?? "").trim().slice(0, 60),
    keyConcepts: toStrArray(obj.keyConcepts, 8, 40),
    readerPositions: toStrArray(obj.readerPositions, 6, 60),
    openQuestions: toStrArray(obj.openQuestions, 6, 60),
    updatedAt: fallback.updatedAt,
  };
  if (!note.theme && !note.keyConcepts.length) {
    throw new Error("模型输出缺少有效骨架内容");
  }
  return note;
}

function toStrArray(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? "").trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}
