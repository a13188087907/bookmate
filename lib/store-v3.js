import fs from "node:fs/promises";
import path from "node:path";

/**
 * 书库存储。所有数据落在插件自有 dataDir 下：
 *   dataDir/books/<bookId>/meta.json        书元数据
 *   dataDir/books/<bookId>/chapters.json    章节列表（含段落全文）
 *   dataDir/books/<bookId>/skeleton.json    书骨架（每章结构化笔记，累积）
 *   dataDir/books/<bookId>/progress.json    阅读进度
 *   dataDir/books/<bookId>/highlights.json  划线集合
 *   dataDir/index.json                      书库索引
 */
export class BookStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.booksDir = path.join(dataDir, "books");
    this.indexFile = path.join(dataDir, "index.json");
    this.books = [];
  }

  async init() {
    await fs.mkdir(this.booksDir, { recursive: true });
    try {
      this.books = JSON.parse(await fs.readFile(this.indexFile, "utf8"));
    } catch {
      this.books = [];
    }
  }

  async saveIndex() {
    await fs.writeFile(this.indexFile, JSON.stringify(this.books, null, 2), "utf8");
  }

  bookDir(bookId) {
    return path.join(this.booksDir, bookId);
  }

  async createBook({ id, title, author, chapters }) {
    const dir = this.bookDir(id);
    await fs.mkdir(path.join(dir, "chapters"), { recursive: true });
    const meta = {
      id,
      title,
      author,
      chapterCount: chapters.length,
      importedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await fs.writeFile(path.join(dir, "chapters.json"), JSON.stringify(chapters, null, 2), "utf8");
    await fs.writeFile(path.join(dir, "skeleton.json"), JSON.stringify({ chapters: [] }, null, 2), "utf8");
    await fs.writeFile(path.join(dir, "progress.json"), JSON.stringify({ chapter: 0, paragraph: 0 }, null, 2), "utf8");
    await fs.writeFile(path.join(dir, "highlights.json"), JSON.stringify([], null, 2), "utf8");
    this.books.push({ id, title, author, chapterCount: chapters.length, importedAt: meta.importedAt });
    await this.saveIndex();
    return meta;
  }

  async listBooks() {
    return this.books;
  }

  async getMeta(bookId) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.bookDir(bookId), "meta.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async getChapters(bookId) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.bookDir(bookId), "chapters.json"), "utf8"));
    } catch {
      return [];
    }
  }

  async getChapter(bookId, idx) {
    const chapters = await this.getChapters(bookId);
    return chapters[Number(idx)] ?? null;
  }

  async getSkeleton(bookId) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.bookDir(bookId), "skeleton.json"), "utf8"));
    } catch {
      return { chapters: [] };
    }
  }

  async saveSkeleton(bookId, skeleton) {
    await fs.writeFile(path.join(this.bookDir(bookId), "skeleton.json"), JSON.stringify(skeleton, null, 2), "utf8");
  }

  async getProgress(bookId) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.bookDir(bookId), "progress.json"), "utf8"));
    } catch {
      return { chapter: 0, paragraph: 0 };
    }
  }

  async saveProgress(bookId, progress) {
    await fs.writeFile(path.join(this.bookDir(bookId), "progress.json"), JSON.stringify(progress, null, 2), "utf8");
  }

  async getHighlights(bookId) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.bookDir(bookId), "highlights.json"), "utf8"));
    } catch {
      return [];
    }
  }

  async saveHighlights(bookId, highlights) {
    await fs.writeFile(path.join(this.bookDir(bookId), "highlights.json"), JSON.stringify(highlights, null, 2), "utf8");
  }

  async removeBook(bookId) {
    await fs.rm(this.bookDir(bookId), { recursive: true, force: true });
    this.books = this.books.filter((b) => b.id !== bookId);
    await this.saveIndex();
  }

  async renameBook(bookId, title) {
    const meta = await this.getMeta(bookId);
    if (!meta) throw new Error("not found");
    meta.title = String(title).trim().slice(0, 120);
    await fs.writeFile(path.join(this.bookDir(bookId), "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    const entry = this.books.find((b) => b.id === bookId);
    if (entry) entry.title = meta.title;
    await this.saveIndex();
    return meta;
  }
}
