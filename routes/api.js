/* v2：reload 即进程重启，lib 被 ESM 缓存钉死的问题不存在了，恢复静态导入。
   loadLib 保留为兼容包装（原调用点不动），直接返回静态导入的函数。 */
import { generateChapterNote, buildSkeletonContext } from "../lib/skeleton.js";
import { exportBookMarkdown } from "../lib/export.js";
import { requireRuntime } from "../src/runtime.js";
import { readAppModelStream } from "../sdk/app-contract/model-stream.js";
import fs from "node:fs/promises";
import path from "node:path";

function loadLib() {
  return Promise.resolve({
    generateChapterNote,
    buildSkeletonContext,
    exportBookMarkdown,
  });
}

/* 内置书友人格：设置项 companionPersona 留空时使用。人格全文对用户可见、可自由改写。 */
const DEFAULT_PERSONA = [
  "你叫书友，是一位和读者并肩读书的伙伴。你认真读过这本书，有自己的理解。",
  "你的第一职责是答疑：读者问什么，就先把什么解释清楚。解释时用大白话，用类比和具体例子，把抽象概念落到地面上。",
  "当读者表达自己的观点时，你再进入讨论：回应他的观点，补充他可能没看到的视角，必要时追问一句。",
  "读者没有发起讨论时，你不反驳、不抬杠、不反问。回答完就停在回答上，不给每段话接一个挑战的尾巴。",
  "禁止用反问回答提问；禁止揣测读者‘真正想问什么’；禁止评价问题本身。直接正面回答。",
  "读者没问的不要主动教：不主动总结章节、不罗列知识点。",
  "说话像朋友，用中文，不用 Markdown。",
].join("\n");

/* 书友模型解析：设置项 companionModel 优先（目录 id / provider/id / 显示名均可）；
   留空跟随当前焦点模型（model:list 的 isCurrent 项）。解析不出给可行动的错误。 */
async function resolveCompanionModel(runtime) {
  const configured = String(await getConfig(runtime, "companionModel").catch(() => "") || "").trim();
  const listed = await runtime.models?.list?.().catch(() => null);
  const models = Array.isArray(listed?.models) ? listed.models : [];
  if (configured) {
    const hit = models.find(
      (m) => m?.id === configured || `${m?.provider}/${m?.id}` === configured || m?.name === configured,
    );
    if (hit) return { provider: hit.provider, model: hit.id, label: hit.name || hit.id };
    const slash = configured.indexOf("/");
    if (slash > 0 && slash < configured.length - 1) {
      return { provider: configured.slice(0, slash), model: configured.slice(slash + 1), label: configured };
    }
    throw new Error(`书友模型「${configured}」不在模型目录里，请到书友设置检查`);
  }
  const current = models.find((m) => m?.isCurrent);
  if (current) return { provider: current.provider, model: current.id, label: current.name || current.id };
  throw new Error("未能解析默认模型，请到书友设置里指定书友模型");
}

/* 书友对话核心（B 路径）：人格 + 上下文进 systemPrompt，历史与当前问题进 messages，
   models.stream 逐事件回调（thinking/delta），返回完整回复与所用模型标签。 */
async function converseWithModel(runtime, { context, userMessage, history, onEvent }) {
  const persona =
    String(await getConfig(runtime, "companionPersona").catch(() => "") || "").trim() || DEFAULT_PERSONA;
  const { provider, model, label } = await resolveCompanionModel(runtime);
  const systemPrompt = `${persona}\n\n${context.beforeUser}`;
  const messages = [
    ...history.slice(-8).map((m) =>
      m?.role === "user"
        ? { role: "user", content: String(m?.content ?? "") }
        : { role: "assistant", content: [{ type: "text", text: String(m?.content ?? "") }] },
    ),
    { role: "user", content: userMessage },
  ];
  const requestId = `bookmate-conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await runtime.models.stream({
    requestId,
    provider,
    model,
    systemPrompt,
    messages,
    temperature: 0.8,
  });
  let accumulated = "";
  let doneReply = null;
  for await (const ev of readAppModelStream(resp)) {
    if (ev.type === "reasoning-delta") {
      onEvent?.({ type: "thinking", delta: ev.delta });
    } else if (ev.type === "text-delta") {
      accumulated += ev.delta;
      onEvent?.({ type: "delta", text: ev.delta });
    } else if (ev.type === "done") {
      doneReply = extractAssistantText(ev.assistant) || accumulated;
    } else if (ev.type === "error") {
      throw new Error(ev.error?.message || String(ev.error || "模型流错误"));
    }
  }
  return { reply: doneReply ?? accumulated, modelLabel: label };
}

/* done.assistant 的文本提取：字符串 / {content} / content 分段数组 多层容错 */
function extractAssistantText(assistant) {
  if (!assistant) return "";
  if (typeof assistant === "string") return assistant;
  const c = assistant.content ?? assistant.text;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  }
  return "";
}

export default function registerBookRoutes(app, ctx) {
  app.post("/api/fonts/import", async (c) => {
    let body;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: "解析上传内容失败" }, 400);
    }
    const raw = body.fonts;
    const files = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!files.length) return c.json({ fonts: [] });
    const fontsDir = path.join(ctx.dataDir, "fonts");
    await fs.mkdir(fontsDir, { recursive: true });
    let list = [];
    try {
      list = JSON.parse(await fs.readFile(path.join(fontsDir, "fonts.json"), "utf8"));
    } catch {}
    const existing = new Set(list.map((f) => f.file));
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      if (!buf.length) continue;
      const safe = String(file.name || "font").replace(/[^\w.\u4e00-\u9fa5-]/g, "_").replace(/\.(ttf|otf)$/i, "");
      if (existing.has(safe)) continue;
      await fs.writeFile(path.join(fontsDir, safe), buf);
      list.push({ name: file.name, family: `书友-${safe}`, file: safe });
      existing.add(safe);
    }
    await fs.writeFile(path.join(fontsDir, "fonts.json"), JSON.stringify(list, null, 2), "utf8");
    return c.json({ ok: true, fonts: list });
  });

  app.get("/api/fonts", async (c) => {
    try {
      const list = JSON.parse(
        await fs.readFile(path.join(ctx.dataDir, "fonts", "fonts.json"), "utf8"),
      );
      return c.json({ fonts: list });
    } catch {
      return c.json({ fonts: [] });
    }
  });

  app.get("/api/fonts/:file", async (c) => {
    const file = c.req.param("file");
    if (!/\.(ttf|otf)$/i.test(file)) return c.text("Not found", 404);
    const fontsDir = path.join(ctx.dataDir, "fonts");
    const filePath = path.resolve(fontsDir, file);
    if (!filePath.startsWith(fontsDir + path.sep)) return c.text("Not found", 404);
    try {
      const buf = await fs.readFile(filePath);
      return new Response(buf, {
        headers: {
          "content-type": /\.otf$/i.test(file) ? "font/otf" : "font/ttf",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.text("Not found", 404);
    }
  });

  app.post("/api/books/import", async (c) => {
    const { store, parser } = requireRuntime(ctx);
    let body;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: "解析上传内容失败" }, 400);
    }
    const raw = body.files;
    const files = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!files.length) return c.json({ results: [] });

    const results = [];
    for (const file of files) {
      const name = file?.name || "未知文件";
      try {
        const buf = Buffer.from(await file.arrayBuffer());
        if (!buf.length) {
          results.push({ ok: false, name, error: "空文件" });
          continue;
        }
        const tmpDir = path.join(ctx.dataDir, "import_tmp");
        await fs.mkdir(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.epub`);
        await fs.writeFile(tmpPath, buf);

        const bookId = `book_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const workDir = path.join(store.bookDir(bookId), "parse_tmp");
        await fs.mkdir(workDir, { recursive: true });
        const meta = await parser.parse(tmpPath, workDir);
        if (meta.chapterCount === 0) {
          results.push({ ok: false, name, error: "没有提取到章节，可能是图片型 EPUB" });
        } else {
          const chapters = JSON.parse(await fs.readFile(path.join(workDir, "chapters.json"), "utf8"));
          await store.createBook({ id: bookId, title: meta.title, author: meta.author, chapters });
          // 迁移插图到书目录
          try {
            await fs.cp(path.join(workDir, "images"), path.join(store.bookDir(bookId), "images"), { recursive: true });
          } catch {}
          results.push({
            ok: true,
            name,
            title: meta.title,
            author: meta.author,
            chapterCount: meta.chapterCount,
          });
        }
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(tmpPath, { force: true }).catch(() => {});
      } catch (err) {
        results.push({ ok: false, name, error: err.message });
      }
    }
    return c.json({ results });
  });

  /* 设置页读写：自定义设置页（ui/settings.html）的数据面。模型目录随行下发（下拉用） */
  app.get("/api/settings", async (c) => {
    const runtime = requireRuntime(ctx);
    const listed = await runtime.models?.list?.().catch(() => null);
    const models = (Array.isArray(listed?.models) ? listed.models : [])
      .map((m) => ({ id: m?.id, name: m?.name || m?.id, provider: m?.provider, isCurrent: !!m?.isCurrent }))
      .filter((m) => m.id && m.provider);
    return c.json({
      pythonCommand: (await getConfig(runtime, "pythonCommand").catch(() => null)) ?? "python",
      exportDir: (await getConfig(runtime, "exportDir").catch(() => null)) ?? "",
      companionModel: (await getConfig(runtime, "companionModel").catch(() => null)) ?? "",
      companionPersona: (await getConfig(runtime, "companionPersona").catch(() => null)) ?? "",
      defaultPersona: DEFAULT_PERSONA,
      models,
    });
  });

  app.put("/api/settings", async (c) => {
    const runtime = requireRuntime(ctx);
    const body = await readJson(c);
    const keys = ["pythonCommand", "exportDir", "companionModel", "companionPersona"];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        await setConfig(runtime, key, String(body[key] ?? ""));
      }
    }
    return c.json({ ok: true });
  });

  app.get("/api/books", async (c) => {
    const { store } = requireRuntime(ctx);
    return c.json({ books: await store.listBooks() });
  });

  app.get("/api/books/:bookId", async (c) => {
    const { store } = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const meta = await store.getMeta(bookId);
    if (!meta) return c.json({ error: "not found" }, 404);
    const progress = await store.getProgress(bookId);
    return c.json({ meta, progress });
  });

  app.get("/api/books/:bookId/chapters", async (c) => {
    const { store } = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const chapters = await store.getChapters(bookId);
    return c.json({
      chapters: chapters.map((ch) => ({
        idx: ch.idx,
        title: ch.title,
        paragraphs: ch.paragraphs.length,
        chars: ch.paragraphs.reduce((n, p) => n + p.length, 0),
      })),
    });
  });

  app.get("/api/books/:bookId/chapters/:idx", async (c) => {
    const { store } = requireRuntime(ctx);
    const chapter = await store.getChapter(c.req.param("bookId"), c.req.param("idx"));
    if (!chapter) return c.json({ error: "not found" }, 404);
    return c.json({ chapter });
  });

  app.post("/api/books/:bookId/progress", async (c) => {
    const runtime = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const body = await readJson(c);
    const current = await runtime.store.getProgress(bookId);
    const next = {
      chapter: Number(body.chapter ?? current.chapter),
      paragraph: Number(body.paragraph ?? current.paragraph),
      updatedAt: new Date().toISOString(),
    };
    await runtime.store.saveProgress(bookId, next);
    // 章节前进：异步为刚读完的章生成骨架（不阻塞响应；失败只记日志；已有笔记不覆盖）
    const prevChapter = Number(current.chapter ?? 0);
    if (Number(next.chapter) > prevChapter) {
      loadLib().then(({ generateChapterNote }) =>
        generateChapterNote(runtime, bookId, prevChapter),
      ).catch((err) => {
        runtime.log?.warn?.(`skeleton auto-gen failed (${bookId} ch${prevChapter}): ${err.message}`);
      });
    }
    return c.json({ ok: true });
  });

  app.post("/api/books/:bookId/chapters/:idx/distill", async (c) => {
    const runtime = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const idx = Number(c.req.param("idx"));
    const body = await readJson(c);
    const chapter = await runtime.store.getChapter(bookId, idx);
    if (!chapter) return c.json({ error: "not found" }, 404);
    try {
      const { generateChapterNote } = await loadLib();
      const dialog = Array.isArray(body.dialog)
        ? body.dialog.slice(-12).map((d) => ({
            role: d?.role === "user" ? "读者" : "书友",
            content: String(d?.content ?? "").slice(0, 400),
          }))
        : null;
      const note = await generateChapterNote(runtime, bookId, idx, { force: Boolean(body.force), dialog });
      return c.json({ ok: true, note });
    } catch (err) {
      runtime.log?.warn?.(`skeleton distill failed (${bookId} ch${idx}): ${err.message}`);
      return c.json({ error: `沉淀失败：${err.message}` }, 500);
    }
  });

  app.delete("/api/books/:bookId", async (c) => {
    const { store } = requireRuntime(ctx);
    await store.removeBook(c.req.param("bookId"));
    return c.json({ ok: true });
  });

  app.post("/api/books/:bookId/rename", async (c) => {
    const { store } = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const body = await readJson(c);
    const title = String(body.title ?? "").trim();
    if (!title) return c.json({ error: "书名不能为空" }, 400);
    try {
      const meta = await store.renameBook(bookId, title);
      return c.json({ ok: true, meta });
    } catch (err) {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.get("/api/books/:bookId/images/:file", async (c) => {
    const { store } = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    // 存储的引用带 "images/" 前缀（解析器遗留），供图时剥掉，两种形态都兼容
    const file = c.req.param("file").replace(/^images[\/]/, "");
    const imgDir = path.join(store.bookDir(bookId), "images");
    const filePath = path.resolve(imgDir, file);
    if (!filePath.startsWith(imgDir + path.sep)) return c.text("Not found", 404);
    try {
      const buf = await fs.readFile(filePath);
      const ext = path.extname(file).toLowerCase();
      const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
      return new Response(buf, {
        headers: { "content-type": mime, "cache-control": "public, max-age=31536000, immutable" },
      });
    } catch {
      return c.text("Not found", 404);
    }
  });

  app.get("/api/books/:bookId/highlights", async (c) => {
    const { store } = requireRuntime(ctx);
    return c.json({ highlights: await store.getHighlights(c.req.param("bookId")) });
  });

  app.post("/api/books/:bookId/highlights", async (c) => {
    const { store } = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const body = await readJson(c);
    await store.saveHighlights(bookId, Array.isArray(body.highlights) ? body.highlights : []);
    return c.json({ ok: true });
  });

  app.post("/api/books/:bookId/converse", async (c) => {
    const runtime = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const body = await readJson(c);
    const chapterIdx = Number(body.chapter ?? 0);
    const userMessage = String(body.message ?? "").slice(0, 2000);
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    const paraIdx = Number.isFinite(Number(body.para)) ? Number(body.para) : null;
    const quote = String(body.quote ?? "").trim().slice(0, 500);

    const meta = await runtime.store.getMeta(bookId);
    const chapter = await runtime.store.getChapter(bookId, chapterIdx);
    if (!meta || !chapter) return c.json({ error: "not found" }, 404);

    try {
      const context = await buildConverseContext(runtime, { bookId, meta, chapterIdx, chapter, quote, paraIdx });
      const { reply, modelLabel } = await converseWithModel(runtime, { context, userMessage, history });
      return c.json({ reply, mode: "stream", model: modelLabel });
    } catch (err) {
      runtime.log?.warn?.(`converse failed: ${err.message}`);
      return c.json({ error: err.message }, 502);
    }
  });

  /** 流式对话：SSE（text/event-stream）。事件协议：
   *  {type:"thinking",delta} 推理增量 / {type:"delta",text} 正文增量
   *  {type:"done",reply,model} 完成 / {type:"error",error} 失败。 */
  app.post("/api/books/:bookId/converse/stream", async (c) => {
    const runtime = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const body = await readJson(c);
    const chapterIdx = Number(body.chapter ?? 0);
    const userMessage = String(body.message ?? "").slice(0, 2000);
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    const paraIdx = Number.isFinite(Number(body.para)) ? Number(body.para) : null;
    const quote = String(body.quote ?? "").trim().slice(0, 500);

    const meta = await runtime.store.getMeta(bookId);
    const chapter = await runtime.store.getChapter(bookId, chapterIdx);
    if (!meta || !chapter) return c.json({ error: "not found" }, 404);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {}
        };
        try {
          const context = await buildConverseContext(runtime, { bookId, meta, chapterIdx, chapter, quote, paraIdx });
          const { reply, modelLabel } = await converseWithModel(runtime, {
            context,
            userMessage,
            history,
            onEvent: (ev) => send(ev),
          });
          send({ type: "done", reply, model: modelLabel });
        } catch (err) {
          runtime.log?.warn?.(`converse stream failed: ${err.message}`);
          send({ type: "error", error: err.message });
        } finally {
          try {
            controller.close();
          } catch {}
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  });

  /** 导出为 Markdown：写入导出目录（页面选择或插件配置 exportDir），《书名》.md 重复导出覆盖 */
  app.post("/api/books/:bookId/export", async (c) => {
    const runtime = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const body = await readJson(c);
    const meta = await runtime.store.getMeta(bookId);
    if (!meta) return c.json({ error: "not found" }, 404);
    const configured = await getConfig(runtime, "exportDir").catch(() => null);
    const dir = String(body.dir ?? "").trim() || String(configured ?? "").trim();
    if (!dir) {
      return c.json(
        { error: "未配置导出目录：请先在插件设置中填写「导出目录」（exportDir），或在页面上选择导出目录。" },
        400,
      );
    }
    try {
      const { exportBookMarkdown } = await loadLib();
      const filePath = await exportBookMarkdown(runtime, bookId, dir);
      // 记住本次目录，下次导出与 agent 工具直接使用
      await setConfig(runtime, "exportDir", dir).catch(() => {});
      return c.json({ ok: true, path: filePath });
    } catch (err) {
      runtime.log?.warn?.(`export failed (${bookId}): ${err.message}`);
      return c.json({ error: `导出失败：${err.message}` }, 500);
    }
  });
}

/**
 * 宿主模型调用：走 bus 事件 model:sample-text（与内置插件同款通道）。
 * 请求：{ systemPrompt, messages, temperature, agentId, pluginId }，返回 { text }。
 */
async function callModel(runtime, prompt, agentId = null) {
  if (typeof runtime.models?.utility !== "function") {
    throw new Error("宿主模型通道不可用");
  }
  const result = await runtime.models.utility({
    requestId: `bookmate-conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    systemPrompt: prompt.split("\n\n")[0],
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });
  return result?.text ?? "";
}

/**
 * 构建书友会话上下文（/converse 与 /converse/stream 共用，保证 prompt 完全一致）：
 * system 提示词保持既有文本原样；beforeUser 注入章节背景 + 引用 + 骨架块。
 * 返回对象额外挂 _skeletonBlock 供 sample 兜底 prompt 复用（宿主序列化时多字段无害）。
 */
async function buildConverseContext(runtime, { bookId, meta, chapterIdx, chapter, quote, paraIdx = null }) {
  // 引用定位：有引文时优先截取引文前后段落作为上下文；无引用时锚定读者当前阅读位置
  const quoteWindow = findQuoteWindow(chapter.paragraphs, quote);
  const readingWindow = quote ? null : findReadingWindow(chapter.paragraphs, paraIdx);
  const chapterText = quote || readingWindow ? null : chapter.paragraphs.join("\n").slice(0, 800);
  // 骨架注入：有内容的骨架压缩成 ≤600 字，追加进 beforeUser
  const skeleton = await runtime.store.getSkeleton(bookId);
  const skeletonBlock = buildSkeletonContext(skeleton);
  const context = {
    system: [
      "你是一位和读者共读一本书的书友。你读过这本书，有自己的理解和立场。",
    ].join("\n"),
    beforeUser: [
      `你们在读《${meta.title}》，当前是第 ${chapterIdx + 1} 章「${chapter.title}」。`,
      quote ? `读者引用了书中这段话，围绕它回应：\n“${quote}”` : null,
      quoteWindow
        ? `引用上下文（引文前后的原文，供你理解它谈论的脉络）：\n${quoteWindow}`
        : readingWindow
          ? `正文节选（读者当前位置附近，供你理解他读到的脉络）：\n${readingWindow}`
          : chapterText
            ? `本章正文开头节选（背景参考）：\n${chapterText}`
            : null,
      skeletonBlock ? `【全书骨架（前情回顾，回答涉及前文时可引用，不必复述）】\n${skeletonBlock}` : null,
    ].filter(Boolean).join("\n\n"),
  };
  context._skeletonBlock = skeletonBlock;
  return context;
}

/* 以读者当前段落为锚点，向前后扩展截取上下文窗口（约 1200 字）。
   paraIdx 无效时返回 null，调用方退回开头节选。 */
function findReadingWindow(paragraphs, paraIdx, budget = 1200) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return null;
  const idx = Number.isFinite(paraIdx) ? Math.max(0, Math.min(paraIdx, paragraphs.length - 1)) : null;
  if (idx == null) return null;
  let lo = idx;
  let hi = idx;
  let total = String(paragraphs[idx] ?? "").length;
  while (total < budget && (lo > 0 || hi < paragraphs.length - 1)) {
    if (hi < paragraphs.length - 1) { hi++; total += String(paragraphs[hi] ?? "").length; }
    if (total >= budget) break;
    if (lo > 0) { lo--; total += String(paragraphs[lo] ?? "").length; }
  }
  return paragraphs.slice(lo, hi + 1).join("\n");
}

/* 用引文在本章段落里定位，截取前后各 2 段作为上下文窗口（约 1200 字）。
   空白归一化后做包含匹配；引文是局部选中时，用前 20 字做定位锚点。
   定位不到（比如引自别章）返回 null，调用方退回开头节选。 */
function findQuoteWindow(paragraphs, quote) {
  if (!Array.isArray(paragraphs) || !paragraphs.length || !quote) return null;
  const norm = (s) => String(s ?? "").replace(/\s+/g, "");
  const q = norm(quote);
  if (!q) return null;
  let hit = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = norm(paragraphs[i]);
    if (p && (p.includes(q) || q.includes(p))) { hit = i; break; }
  }
  if (hit === -1 && q.length > 20) {
    const anchor = q.slice(0, 20);
    for (let i = 0; i < paragraphs.length; i++) {
      if (norm(paragraphs[i]).includes(anchor)) { hit = i; break; }
    }
  }
  if (hit === -1) return null;
  const from = Math.max(0, hit - 2);
  const to = Math.min(paragraphs.length, hit + 3);
  return paragraphs.slice(from, to).join("\n").slice(0, 1200);
}

/** 读插件配置（exportDir 等） */
async function getConfig(runtime, key) {
  const config = runtime.config ?? runtime.ctx?.config;
  if (config?.get) return config.get(key);
  return null;
}

/** 写插件配置（失败不阻断主流程） */
async function setConfig(runtime, key, value) {
  const config = runtime.config ?? runtime.ctx?.config;
  if (config?.set) await config.set(key, value);
}

async function readJson(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
