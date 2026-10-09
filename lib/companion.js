/**
 * 书友对话 prompt 构建。
 * V1：单轮无状态，上下文 = 当前章节正文 + 最近对话历史。
 * V2：将书骨架（skeleton）注入此处，实现跨章节记忆。
 */

export function buildCompanionPrompt({
  bookTitle,
  chapterIdx,
  chapterTitle,
  chapterText,
  quote = "",
  userMessage,
  history,
  skeletonContext = null,
}) {
  const historyBlock =
    history.length > 0
      ? history
          .map((m) => `${m.role === "user" ? "读者" : "书友"}：${m.content}`)
          .join("\n")
      : "（本章还没有对话）";

  const quoteBlock = quote
    ? [``, `【读者划线的引用】`, `“${quote}”`, ``].join("\n")
    : "";

  const system = [
    `你是一位与读者共读《${bookTitle}》的书友。你读过这本书，有自己的理解和立场。`,
    `读者刚刚读完第 ${chapterIdx + 1} 章「${chapterTitle}」。`,
    `行为准则：`,
    `1. 读者提问时，先把问题解释清楚：可以讲正文、可以举具体例子，解释到位是第一要务。`,
    `2. 读者表达观点时，先回应观点本身，再给不同视角或追问，把讨论往深推一层。`,
    `3. 禁止用反问回答提问；禁止揣测读者‘真正想问什么’；禁止评价问题本身。直接正面回答。`,
    `4. 读者没问的不要主动教，不主动总结章节。`,
    `5. 像朋友聊天一样说话，不用 Markdown 格式。`,
    `6. 用中文。`,
  ].join("\n");

  const skeletonBlock = skeletonContext
    ? [``, `【全书骨架（前情回顾，回答涉及前文时可引用，不必复述）】`, skeletonContext, ``].join("\n")
    : "";

  const prompt = [
    system,
    ``,
    `【本章正文（供你引用具体细节，节选）】`,
    chapterText || "（本章正文为空）",
    quoteBlock,
    skeletonBlock,
    `【最近对话】`,
    historyBlock,
    ``,
    `读者说：${userMessage}`,
    ``,
    `作为书友，你的回应：`,
  ].join("\n");

  return prompt;
}
