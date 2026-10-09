/* v2：reload 即进程重启，lib 被 ESM 缓存钉死的问题不存在了，恢复静态导入。
   loadLib 保留为兼容包装（原调用点不动），直接返回静态导入的函数。 */
import { buildCompanionPrompt } from "../lib/companion.js";
import { generateChapterNote, buildSkeletonContext } from "../lib/skeleton.js";
import { exportBookMarkdown } from "../lib/export.js";
import { ensureCompanionAgent } from "../lib/companion-agent.js";
import { requireRuntime } from "../src/runtime.js";
import fs from "node:fs/promises";
import path from "node:path";

function loadLib() {
  return Promise.resolve({
    buildCompanionPrompt,
    generateChapterNote,
    buildSkeletonContext,
    exportBookMarkdown,
    ensureCompanionAgent,
  });
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

  app.get("/api/agents", async (c) => {
    const runtime = requireRuntime(ctx);
    try {
      const raw = await runtime.bus?.request?.("agent:list", { scope: "all", includePluginPrivate: true });
      const list = Array.isArray(raw) ? raw : (raw?.agents || raw?.items || []);
      return c.json({
        agents: list
          .map((a) => ({ id: a?.id ?? a?.agentId, name: a?.name ?? a?.id ?? a?.agentId }))
          .filter((a) => a.id),
      });
    } catch {
      return c.json({ agents: [] });
    }
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
      const note = await generateChapterNote(runtime, bookId, idx, { force: Boolean(body.force) });
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
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    // 前端显式选择的助手优先；未选择（默认项）时用配置的专用「书友」agent；
    // 配置未持久化（宿主配置 schema 按进程缓存，新键需重启宿主后才能写）时，
    // 直接调 ensureCompanionAgent 查重复用已创建的书友 agent，保证人格生效。
    let agentId =
      String(body.agentId ?? "").trim() ||
      (await getConfig(runtime, "companionAgentId").catch(() => null)) ||
      null;
    if (!agentId) {
      const { ensureCompanionAgent } = await loadLib();
      agentId = await ensureCompanionAgent(runtime).catch(() => null);
    }
    const quote = String(body.quote ?? "").trim().slice(0, 500);

    const meta = await runtime.store.getMeta(bookId);
    const chapter = await runtime.store.getChapter(bookId, chapterIdx);
    if (!meta || !chapter) return c.json({ error: "not found" }, 404);

    const context = await buildConverseContext(runtime, { bookId, meta, chapterIdx, chapter, quote });

    let reply = null;
    let mode = "session";
    try {
      if (runtime.companion?.bus) {
        reply = await runtime.companion.converse({ bookId, agentId, userMessage, context });
      }
    } catch (err) {
      runtime.log?.warn?.(`session converse failed, fallback to sample: ${err.message}`);
    }
    if (reply == null) {
      mode = "sample";
      const { buildCompanionPrompt } = await loadLib();
      const prompt = buildCompanionPrompt({
        bookTitle: meta.title,
        chapterIdx,
        chapterTitle: chapter.title,
        chapterText: chapter.paragraphs.join("\n").slice(0, 3000),
        quote,
        userMessage,
        history: [],
        skeletonContext: context._skeletonBlock ?? null,
      });
      reply = await callModel(runtime, prompt, agentId);
    }
    return c.json({ reply, mode });
  });

  /** 流式对话：SSE（text/event-stream）。事件协议：
   *  {type:"delta",text} 增量追加 / {type:"done",reply,mode} 完成 / {type:"error",error} 失败。
   *  宿主当前无流式增量（探测结论），增量 = 完整回复单个 delta，前端表现等价现状不更差。 */
  app.post("/api/books/:bookId/converse/stream", async (c) => {
    const runtime = requireRuntime(ctx);
    const bookId = c.req.param("bookId");
    const body = await readJson(c);
    const chapterIdx = Number(body.chapter ?? 0);
    const userMessage = String(body.message ?? "").slice(0, 2000);
    // 前端显式选择的助手优先；未选择（默认项）时用配置的专用「书友」agent；
    // 配置未持久化时（同上）直接 ensure 查重复用，保证人格生效。
    let agentId =
      String(body.agentId ?? "").trim() ||
      (await getConfig(runtime, "companionAgentId").catch(() => null)) ||
      null;
    if (!agentId) {
      const { ensureCompanionAgent } = await loadLib();
      agentId = await ensureCompanionAgent(runtime).catch(() => null);
    }
    const quote = String(body.quote ?? "").trim().slice(0, 500);

    const meta = await runtime.store.getMeta(bookId);
    const chapter = await runtime.store.getChapter(bookId, chapterIdx);
    if (!meta || !chapter) return c.json({ error: "not found" }, 404);

    const context = await buildConverseContext(runtime, { bookId, meta, chapterIdx, chapter, quote });
    const { buildCompanionPrompt } = await loadLib();
    const promptFallback = buildCompanionPrompt({
      bookTitle: meta.title,
      chapterIdx,
      chapterTitle: chapter.title,
      chapterText: chapter.paragraphs.join("\n").slice(0, 3000),
      quote,
      userMessage,
      history: [],
      skeletonContext: context._skeletonBlock ?? null,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {}
        };
        try {
          let reply = null;
          let mode = "session";
          if (runtime.companion?.bus) {
            try {
              reply = await runtime.companion.converseStream({
                bookId,
                agentId,
                userMessage,
                context,
                onDelta: (text) => send({ type: "delta", text }),
              });
            } catch (err) {
              runtime.log?.warn?.(`session converse failed, fallback to sample: ${err.message}`);
            }
          }
          if (reply == null) {
            mode = "sample";
            reply = await callModel(runtime, promptFallback, agentId);
          }
          send({ type: "done", reply, mode });
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
async function buildConverseContext(runtime, { bookId, meta, chapterIdx, chapter, quote }) {
  const chapterText = chapter.paragraphs.join("\n").slice(0, 3000);
  // 引用定位：有引文时优先截取引文前后段落作为上下文
  const quoteWindow = findQuoteWindow(chapter.paragraphs, quote);
  // 骨架注入：有内容的骨架压缩成 ≤600 字，追加进 beforeUser
  const skeleton = await runtime.store.getSkeleton(bookId);
  const { buildSkeletonContext } = await loadLib();
  const skeletonBlock = buildSkeletonContext(skeleton);
  const context = {
    system: [
      "你是一位和读者共读一本书的书友。你读过这本书，有自己的理解和立场。",
      "行为准则：",
      "1. 读者提问时，先把问题解释清楚：可以讲正文、可以展开背景、可以举具体例子，解释到位是第一要务。",
      "2. 读者表达观点时，先回应观点本身，再给不同视角或追问，把讨论往深推一层。",
      "3. 禁止用反问回答提问；禁止揣测读者‘真正想问什么’；禁止评价问题本身（如‘这个问题太教科书’）。直接正面回答。",
      "4. 读者没问的不要主动教：不主动总结章节、不罗列知识点。",
      "5. 像朋友聊天一样说话，不用 Markdown 格式。",
      "6. 用中文。",
    ].join("\n"),
    beforeUser: [
      `你们在读《${meta.title}》，当前是第 ${chapterIdx + 1} 章「${chapter.title}」。`,
      quote ? `读者引用了书中这段话，围绕它回应：\n“${quote}”` : null,
      quoteWindow
        ? `引用上下文（引文前后的原文，供你理解它谈论的脉络）：\n${quoteWindow}`
        : chapterText
          ? `本章正文开头节选（背景参考）：\n${chapterText.slice(0, 800)}`
          : null,
      skeletonBlock ? `【全书骨架（前情回顾，回答涉及前文时可引用，不必复述）】\n${skeletonBlock}` : null,
    ].filter(Boolean).join("\n\n"),
  };
  context._skeletonBlock = skeletonBlock;
  return context;
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
