# BookMate 架构

一页纸讲清 BookMate 的结构与数据流向，给想读代码或贡献的人。

## 分层

```
index.js                  入口：defineApp 装配（store / parser / 工具注册）
manifest.json             清单：能力声明、设置 schema、卡片声明（structural page）
routes/api.js             Hono 后端路由：书库 / 章节 / 进度 / 划线 / 对话 / 沉淀 / 导出
lib/
  store-v3.js             本地 JSON 存储（app-data/bookmate/：meta / chapters / progress / highlights）
  epub-parse.js           EPUB 解析（调用本机 Python：scripts/parse_epub.py）
  skeleton.js             全书骨架：章节沉淀笔记的生成与注入
  export.js               导出 Markdown（骨架 / 立场演变 / 划线）
src/runtime.js            运行时单例（同进程 ESM 模块缓存，routes 与入口共享状态）
ui/
  reader.html             静态壳 + 启动引导（无构建步骤）
  assets/reader.js        阅读器全部前端逻辑（窗口化滚动 / 划线 / 尺牍对话 / 导轨 / 排版面板）
  assets/reader.css       设计令牌与全部样式（body[data-theme] 主题变量）
sdk/                      打包时随附的 App SDK 本地副本（安装后不依赖宿主 node_modules）
scripts/parse_epub.py     EPUB 解析辅助脚本
```

## 数据流

**阅读**：EPUB → Python 解析 → 章节 JSON 存 app-data → UI 按章懒加载正文，窗口化渲染（±1 章渲染、±2 章保留、滚动补偿卸载）。

**对话**：UI 选中句子/输入 → `POST /api/books/<id>/converse/stream`（SSE）→ 路由组装：设置的人格全文（或内置默认）进 systemPrompt，章节窗口（引用 ±2 段 / 阅读位置锚点约 1200 字 / 章首 800 字）+ 全书骨架 + 对话历史（近 8 条）进上下文 → `ctx.models.stream` 逐事件返回（reasoning-delta 驱动「思考中」，text-delta 驱动真流式）→ 前端信笺逐字显现，收尾落款。

**模型解析**：设置项 companionModel 优先（目录 id / provider/id / 显示名）；留空取 `model:list` 的 isCurrent 项（用户当前焦点模型）。应用不在任何别处创建 Agent 或会话。

**骨架**：「沉淀本章」→ 章节节选 + 当前对话记录（UI 随行）→ 宿主 utility 模型 → 结构化 JSON 存入书数据 → 后续对话自动注入。

**划线**：前端按（章节 idx · 段落 idx · start · end）锚定存 app-data/highlights；窗口卸载重排不丢。

## 关键设计

- **每书一段连续对话**：聊天归档不按章切分；发送时的章节只作为上下文，不作为归档边界。新对话归档进 threads（本地，可回看），清除只清当前段
- **人格与模型都是用户设置**：书友不是被创建的 Agent，而是一段可见可改的人格文本 + 一个可指定的模型。应用的权力边界止于用户自己的模型配置
- **模型调用走 B 路径**：`ctx.models.stream` 直连宿主模型通道（真流式、真推理增量），不经过 agent 会话层；用量走宿主的 models.infer 账目
- **启动 IO 推迟**：激活窗口内的重活（存储装载）延迟执行，避免激活期 RPC 故障被归因为装载失败

## 已知边界

- EPUB 解析依赖本机 Python（设置项可配命令名）；无 Python 环境时导入不可用，其余功能不受影响
- 宿主当前对伴读会话不下发流式增量（单条 delta），前端的逐字显现是客户端模拟；宿主真出增量时同一套逻辑自动变成真流式
