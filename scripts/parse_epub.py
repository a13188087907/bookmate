# -*- coding: utf-8 -*-
"""EPUB 解析管道：解包、按 spine 顺序提取章节、清洗为纯文本段落。

用法：python parse_epub.py <epub路径> <输出目录>
输出：输出目录下写 meta.json（书名/作者/章节数）与 chapters.json（章节列表）。
stdout 末行打印 meta JSON，供 Node 侧读取。
只依赖标准库（zipfile、html.parser、re），无需 pip install。
"""

import json
import os
import re
import sys
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote


class TextExtractor(HTMLParser):
    """把 XHTML 清洗成文本行，丢弃 script/style 与标签噪声。
    标题（h1-h4 或 font size=7+加粗的伪标题）单独收集为
    (level, text, pos, kind)，pos = 标题前的行数，kind = "h"|"pseudo"；
    图片 src 单独收集。"""

    def __init__(self):
        super().__init__()
        self.lines = []
        self.cur = []
        self.skip = 0
        self.head_depth = 0
        self.heading_depth = 0
        self.heading_buf = []
        self.headings = []  # (level, text, pos, kind)
        self.images = []
        # 伪标题（font size=7 + b）状态
        self.p_align = None
        self.size7 = 0
        self.in_title = False
        self.title_start = 0
        self.title_level = 2

    def _end_line(self):
        s = "".join(self.cur).strip()
        if s:
            self.lines.append(s)
        self.cur = []

    def handle_starttag(self, tag, attrs):
        am = dict(attrs)
        if tag in ("script", "style"):
            self.skip += 1
        if tag == "head":
            self.head_depth += 1
        if self.head_depth == 0 and tag in ("h1", "h2", "h3", "h4"):
            self.headings.append((int(tag[1]), "", len(self.lines), "h"))
            self.heading_depth += 1
        if self.head_depth == 0 and tag == "p":
            self.p_align = am.get("align") or ""
        if self.head_depth == 0 and tag == "font":
            size = am.get("size") or ""
            if str(size).strip() == "7":
                self.size7 += 1
        if self.head_depth == 0 and tag == "b" and self.size7 > 0:
            if not self.in_title:
                self.in_title = True
                self.title_start = len(self.lines)
                self.title_level = 2 if self.p_align == "center" else 3
        if self.head_depth == 0 and tag == "img":
            src = am.get("src") or am.get("data-src") or ""
            if src:
                # 记录 (src, 位置)：位置 = 图片出现前的文本行数，供前端原位插入
                self.images.append((src, len(self.lines)))
        if self.head_depth == 0 and self.heading_depth == 0 and tag in ("p", "div", "br", "li", "blockquote", "td", "tr"):
            self._end_line()

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip > 0:
            self.skip -= 1
        if tag == "head" and self.head_depth > 0:
            self.head_depth -= 1
        if self.head_depth == 0 and tag in ("h1", "h2", "h3", "h4"):
            if self.heading_depth > 0:
                self.heading_depth -= 1
                if self.heading_depth == 0:
                    text = "".join(self.heading_buf).strip()
                    if text:
                        self.headings[-1] = (self.headings[-1][0], text, self.headings[-1][2], "h")
                    self.heading_buf = []
                    self._end_line()
        if self.head_depth == 0 and tag == "b" and self.in_title:
            self.in_title = False
        if self.head_depth == 0 and tag == "font" and self.size7 > 0:
            self.size7 -= 1
        if self.head_depth == 0 and tag == "p":
            if self.heading_buf:
                text = "".join(self.heading_buf).strip()
                if text:
                    self.headings.append((self.title_level, text, self.title_start, "pseudo"))
                self.heading_buf = []
            self.p_align = None
            self.in_title = False
        if self.head_depth == 0 and self.heading_depth == 0 and tag in ("p", "div", "h1", "h2", "h3", "h4", "li", "blockquote", "td", "tr"):
            self._end_line()

    def handle_data(self, data):
        if self.heading_depth > 0 or self.in_title:
            self.heading_buf.append(data)
        elif self.skip == 0 and self.head_depth == 0:
            self.cur.append(data)

    def text(self):
        self._end_line()
        return self.lines


def find_opf(zf):
    container = zf.read("META-INF/container.xml").decode("utf-8", errors="replace")
    m = re.search(r'full-path="([^"]+)"', container)
    if not m:
        raise RuntimeError("container.xml 中未找到 OPF 路径")
    return m.group(1)


def clean_title(raw):
    """精简过长/带营销文案的书名（Z-Library 等书源常见）。"""
    title = (raw or "").strip()
    # 括号内营销文案：取括号前主干
    if len(title) > 40 and "（" in title and "）" in title:
        head = title.split("（")[0].strip()
        if len(head) >= 6:
            title = head
    if len(title) > 60:
        title = title[:60]
    return title


def parse_opf(zf, opf_path):
    opf_dir = os.path.dirname(opf_path)
    opf = zf.read(opf_path).decode("utf-8", errors="replace")
    title_m = re.search(r"<dc:title[^>]*>([^<]+)</dc:title>", opf)
    author_m = re.search(r"<dc:creator[^>]*>([^<]+)</dc:creator>", opf)
    title = clean_title(title_m.group(1)) if title_m else os.path.basename(opf_path)
    author = author_m.group(1).strip() if author_m else ""
    # 属性顺序无关地解析 item / itemref（Calibre 等工具生成的 OPF 属性顺序不固定）
    manifest = {}
    for m in re.finditer(r"<item\b[^>]*>", opf):
        tag = m.group(0)
        idm = re.search(r"\bid=\"([^\"]+)\"", tag)
        hrefm = re.search(r"\bhref=\"([^\"]+)\"", tag)
        if idm and hrefm:
            manifest[idm.group(1)] = hrefm.group(1)
    spine = []
    for m in re.finditer(r"<itemref\b[^>]*>", opf):
        tag = m.group(0)
        idrefm = re.search(r"\bidref=\"([^\"]+)\"", tag)
        if idrefm:
            href = manifest.get(idrefm.group(1))
            if href:
                spine.append(href)
    return title, author, opf_dir, spine


def resolve_href(opf_dir, href):
    href = href.split("#")[0]
    return os.path.normpath(os.path.join(opf_dir, href)).replace("\\", "/")


PART_RE = re.compile(r"^第[一二三四五六七八九十百千万0-9]+(部分|部|卷|册)|^Part\b")
# 元信息标题：切分后若块内容极少则丢弃（目录/简介/出版说明等）
META_RE = re.compile(
    r"^(目录|目次|總目錄|总目录|作者简介|内容简介|出版說明|出版说明|新校本說明|新校本说明|版权|版權|序言|前言|后记|後記|跋)"
)


def split_file(headings, paras, images):
    """多标题文件按章切分。headings: [(level, text, pos, kind)]。
    场景：
    - part 文件（首标题为 第X部分/Part）→ 后续 level<=2 标题为章，丢 part 标题
    - 伪标题多章文件（font size7 加粗，kind=pseudo）→ 全部 center 级标题为章
    普通书（h1 章标题 + h2 节）不切。"""
    cuts = [(pos, text) for lv, text, pos, kind in headings if lv <= 2]
    if len(cuts) < 2:
        return None
    first_kind = headings[0][3]
    if PART_RE.match(cuts[0][1].strip()):
        keep_first = True  # 丢 part 标题
    elif first_kind == "pseudo":
        keep_first = False  # 伪标题文件：全部作为章
    else:
        return None  # 普通 h1 章标题 + h2 节，不切
    starts = cuts[1:] if keep_first else cuts
    res = []
    for k, (pos, title) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else len(paras)
        body = paras[pos:end]
        subs = [t for lv, t, p, kd in headings if lv >= 3 and pos <= p < end]
        # 图片按位置归入所在章（首页之前的图并入第一章），pos 转为章内局部位置
        low = 0 if k == 0 else pos
        ch_images = [
            {"path": im["path"], "pos": max(0, int(im.get("pos", 0)) - low)}
            for im in images
            if low <= int(im.get("pos", 0)) < end
        ]
        res.append({
            "title": title[:100],
            "subheadings": [s[:80] for s in subs[:20]],
            "paragraphs": body,
            "images": ch_images,
        })
    # part 标题前的内容并入第一块
    if res:
        pre_end = starts[0][0] if keep_first else 0
        pre = paras[:pre_end]
        if pre:
            res[0]["paragraphs"] = pre + res[0]["paragraphs"]
    # 元信息块过滤（目录/简介/说明等无正文价值的短块）
    res = [ch for ch in res
           if not (META_RE.match(ch["title"].strip()) and len("".join(ch["paragraphs"])) < 300)]
    # 空块过滤（如"第一讲/第一編"层级封面标题，无正文）
    res = [ch for ch in res if "".join(ch["paragraphs"]).strip() or ch["images"]]
    return res or None


def main():
    # Windows 上 stdout 默认 GBK，强制 UTF-8，避免 Node 侧解码乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 3:
        print("用法：python parse_epub.py <epub路径> <输出目录>", file=sys.stderr)
        sys.exit(2)
    epub_path = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    with zipfile.ZipFile(epub_path) as zf:
        names = set(zf.namelist())
        opf_path = find_opf(zf)
        title, author, opf_dir, spine = parse_opf(zf, opf_path)

        # 第一遍：提取所有文件，收集标题层级统计
        docs = []
        for i, href in enumerate(spine):
            p = resolve_href(opf_dir, href)
            if p not in names:
                continue
            raw = zf.read(p).decode("utf-8", errors="replace")
            ex = TextExtractor()
            try:
                ex.feed(raw)
            except Exception:
                continue
            paras = ex.text()

            # 提取插图文件到输出目录，供前端显示。
            # 注意：src 相对于当前 XHTML 文件所在目录解析（不是 OPF 目录），
            # 并做 URL 解码（%20 等），否则 nested 目录结构的书会全部匹配失败。
            images = []
            xhtml_dir = os.path.dirname(p)
            for src, pos in ex.images:
                img_full = resolve_href(xhtml_dir, unquote(src).split("#")[0])
                if img_full not in names:
                    # 退回 OPF 目录解析（兼容 src 以 OPF 为基准的旧式 EPUB）
                    img_full = resolve_href(opf_dir, unquote(src).split("#")[0])
                if img_full not in names:
                    continue
                ext = os.path.splitext(img_full)[1].lower() or ".img"
                out_name = "images/ch%d_%d%s" % (i, len(images), ext)
                out_abs = os.path.join(out_dir, out_name)
                os.makedirs(os.path.dirname(out_abs), exist_ok=True)
                with open(out_abs, "wb") as f:
                    f.write(zf.read(img_full))
                images.append({"path": out_name, "pos": pos})

            docs.append((i, ex, paras, images))

        chapters = []
        for i, ex, paras, images in docs:
            # 图片型章节（无文本）也保留，不再整体丢弃
            if not paras and not images:
                continue

            # 逐文件尝试按章切分（part 文件 / 伪标题多章文件）；失败走单标题逻辑
            sub = split_file(ex.headings, paras, images)
            if sub:
                chapters.extend(sub)
                continue

            # 单标题文件：优先取收集到的第一个；副标题单独列出不进正文
            heading = ex.headings[0][1] if ex.headings else None
            subheadings = [t for lv, t, p, kd in ex.headings[1:] if lv >= 2][:20]
            body = paras
            if heading:
                # 标题文本已从正文分离；若首行仍是标题残留则去掉
                if body and body[0] == heading:
                    body = body[1:]
            else:
                # 无标题标签：首行若是短句则当作标题
                if paras and not (len(paras[0]) > 40 and paras[0][-1] in "。？！；，、："):
                    heading = paras[0]
                    body = paras[1:]
                else:
                    heading = "第 %d 节" % (i + 1)

            chapters.append({
                "idx": i,
                "title": heading[:100],
                "subheadings": [s[:80] for s in subheadings],
                "paragraphs": body,
                "images": images,
            })

        # 切分后 idx 统一连续编号
        for n, ch in enumerate(chapters):
            ch["idx"] = n

    meta = {"title": title, "author": author, "chapterCount": len(chapters)}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "chapters.json"), "w", encoding="utf-8") as f:
        json.dump(chapters, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
