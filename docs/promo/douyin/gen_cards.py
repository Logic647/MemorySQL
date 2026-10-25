# -*- coding: utf-8 -*-
"""抖音图文卡生成:MemorySQL v0.7.0(1080×1440,3:4,共 6 张)

品牌色取自 src/renderer/src/styles/tokens.css,与产品 UI 同源。
用法:python gen_cards.py(输出 card-1.png … card-6.png 到脚本同目录)
"""
import os
import re
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1440
M = 96                      # 页边距
CW = W - M * 2              # 内容宽 888

BG = (7, 11, 18)            # --msql-bg
BG_EL = (12, 17, 27)        # --msql-bg-elevated
FG = (238, 243, 249)        # --msql-fg
SOFT = (206, 215, 228)
MUT = (148, 163, 184)       # --msql-fg-muted
DIM = (100, 116, 139)       # --msql-fg-dim
ACC = (79, 140, 255)        # --msql-accent
HAIR = (32, 42, 58)         # 分隔线/描边
DOT_OFF = (42, 52, 68)

FD = r"C:\Windows\Fonts"
_cache = {}
def F(name, size):
    key = (name, size)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(os.path.join(FD, name), size)
    return _cache[key]
def yh(s):  return F("msyh.ttc", s)
def yhb(s): return F("msyhbd.ttc", s)
def mo(s):  return F("consola.ttf", s)
def mob(s): return F("consolab.ttf", s)


_TOK = re.compile(r"[A-Za-z0-9_@/.\-]+|.")
def wrap(d, text, fnt, maxw):
    """ASCII 词元原子折行,中文逐字折行"""
    lines, cur = [], ""
    for tok in _TOK.findall(text):
        cand = cur + tok
        if d.textlength(cand, font=fnt) <= maxw or not cur.strip():
            cur = cand
        else:
            lines.append(cur.rstrip())
            cur = tok if tok.strip() else ""
    if cur.strip():
        lines.append(cur.rstrip())
    return lines


def new_card(idx):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # 顶部微亮纵向渐变
    for y in range(H):
        t = y / H
        c = tuple(int(BG_EL[i] * (1 - t) + BG[i] * t) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)
    # 右上角一抹柔和强调色辉光
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse((600, -420, 1640, 620), fill=40)
    glow = glow.filter(ImageFilter.GaussianBlur(190))
    img.paste(Image.new("RGB", (W, H), ACC), (0, 0), glow)
    d = ImageDraw.Draw(img)
    return img, d


def brand(d, chip_text):
    y = 92
    x = M
    for ch in "MEMORYSQL":          # 手动字距
        d.text((x, y), ch, font=mob(34), fill=ACC)
        x += d.textlength(ch, font=mob(34)) + 6
    f = yhb(28)
    tw = d.textlength(chip_text, font=f)
    d.rounded_rectangle((W - M - tw - 40, y - 2, W - M, y + 46), radius=24,
                        fill=(17, 27, 50), outline=(45, 66, 105), width=2)
    d.text((W - M - tw - 20, y + 6), chip_text, font=f, fill=ACC)


def footer(d, idx, total=6):
    y = H - 88
    d.text((M, y), "github.com/Logic647/MemorySQL", font=mo(26), fill=DIM)
    for i in range(total):
        cx = W - M - 6 - (total - 1 - i) * 30
        d.ellipse((cx - 6, y + 10, cx + 6, y + 22),
                  fill=ACC if i == idx else DOT_OFF)


def headline(d, y, lines, size=84, fill=FG):
    lh = int(size * 1.3)
    for ln in lines:
        d.text((M, y), ln, font=yhb(size), fill=fill)
        y += lh
    return y


def bar(d, y, w=128):
    d.rectangle((M, y, M + w, y + 8), fill=ACC)
    return y + 8


def bullets(d, y, items, size=40, gap=30):
    f = yh(size)
    lh = int(size * 1.42)
    for it in items:
        lines = wrap(d, it, f, CW - 44)
        d.rectangle((M + 2, y + int(size * 0.34), M + 16, y + int(size * 0.34) + 13), fill=ACC)
        for ln in lines:
            d.text((M + 44, y), ln, font=f, fill=SOFT)
            y += lh
        y += gap
    return y


def notes(d, y, items, size=34, gap=18):
    f = yh(size)
    lh = int(size * 1.45)
    for it in items:
        for ln in wrap(d, "· " + it, f, CW):
            d.text((M, y), ln, font=f, fill=DIM)
            y += lh
        y += gap
    return y


def chips(d, y, texts, size=34):
    f = yhb(size)
    x = M
    for t in texts:
        tw = d.textlength(t, font=f)
        d.rounded_rectangle((x, y, x + tw + 56, y + 66), radius=33,
                            fill=(17, 27, 50), outline=(45, 66, 105), width=2)
        d.text((x + 28, y + 13), t, font=f, fill=ACC)
        x += tw + 56 + 24
    return y + 66


def panel_rows(d, y, rows, h=168, gap=28):
    """rows: [(label, desc), …];标签列宽按最长标签自适应,desc 自动折行"""
    f_l = yhb(42)
    f_d = yh(34)
    lh = int(34 * 1.42)
    label_w = max(int(d.textlength(l, font=f_l)) for l, _ in rows)
    tx = M + 36 + label_w + 44
    for label, desc in rows:
        d.rounded_rectangle((M, y, W - M, y + h), radius=24,
                            fill=BG_EL, outline=HAIR, width=2)
        d.text((M + 36, y + (h - 56) // 2), label, font=f_l, fill=ACC)
        lines = wrap(d, desc, f_d, W - M - tx - 36)
        ty = y + (h - lh * len(lines)) // 2 - 4
        for ln in lines:
            d.text((tx, ty), ln, font=f_d, fill=SOFT)
            ty += lh
        y += h + gap
    return y


def code_panel(d, y, text):
    """代码样式小面板:mono + 强调色"""
    f = mo(34)
    tw = d.textlength(text, font=f)
    d.rounded_rectangle((M + 44, y, M + 44 + int(tw) + 56, y + 64), radius=14,
                        fill=(10, 15, 24), outline=HAIR, width=2)
    d.text((M + 44 + 28, y + 14), text, font=f, fill=ACC)
    return y + 64


def out_panel(d, y, h, lines):
    """底部信息面板:lines = [(text, font, fill), …] 逐行"""
    d.rounded_rectangle((M, y, W - M, y + h), radius=24,
                        fill=BG_EL, outline=HAIR, width=2)
    ty = y + (h - sum(int(s * 1.5) for _, s, _ in lines)) // 2 + 6
    for text, size, fill in lines:
        f = yhb(size) if fill is ACC else yh(size)
        d.text((M + 40, ty), text, font=f, fill=fill)
        ty += int(size * 1.5)
    return y + h


# ---------- 卡 1 · 封面 ----------
img, d = new_card(0)
brand(d, "v0.7.0 更新")
y = headline(d, 440, ["换 AI agent", "不用再从头铺垫背景"], size=96)
y = bar(d, y + 44)
y += 52
d.text((M, y), "12 家编码 agent 的记忆,可以住在同一个地方", font=yh(40), fill=MUT)
y = chips(d, y + 96, ["会话自动捕获", "本地 SQLite", "MCP 续接"])
out_panel(d, H - 220, 104, [
    ("开源 · 本地优先 · Windows / Linux / macOS", 36, SOFT),
])
footer(d, 0)
img.save("card-1.png")

# ---------- 卡 2 · 项目滚动总结 ----------
img, d = new_card(1)
brand(d, "v0.7.0 更新")
y = headline(d, 264, ["新功能:项目滚动总结"])
y = bar(d, y + 28)
y += 48
d.text((M, y), "agent 接手项目,读一份总结就够", font=yh(40), fill=MUT)
y = bullets(d, y + 92, [
    "定期把新会话消化成:摘要 + 待办 + 决策",
    "滚动续写 —— 过时的删掉,新信息并进去",
    "按「从零接手」标准写,上限 1500 字",
    "首次开启:一次性消化全部历史会话(20 个/批)",
    "agent 侧新增 MCP 工具,接手就读这一份:",
])
y = code_panel(d, y + 4, "memory_get_project_digest")
chips(d, y + 36, ["默认关闭", "可手动触发"])
footer(d, 1)
img.save("card-2.png")

# ---------- 卡 3 · 隐私三条线 ----------
img, d = new_card(2)
brand(d, "v0.7.0 更新")
y = headline(d, 264, ["隐私三条线", "想走哪条走哪条"])
y = bar(d, y + 28)
y += 56
y = panel_rows(d, y, [
    ("不开启", "默认模式:无触发、无界面、无发送"),
    ("配了 LLM", "素材先本地脱敏,再发给 LLM"),
    ("没配 LLM", "纯本地规则总结,零外发"),
])
d.text((M, y + 26), "本地明文,出口脱敏 —— 一直没变", font=yhb(38), fill=FG)
footer(d, 2)
img.save("card-3.png")

# ---------- 卡 4 · LLM 引擎聚合 ----------
img, d = new_card(3)
brand(d, "v0.7.0 更新")
y = headline(d, 264, ["免费 API,一键预置"])
y = bar(d, y + 28)
y += 48
d.text((M, y), "总结 / 摘要 / 记忆精炼,共用一个引擎", font=yh(40), fill=MUT)
y = bullets(d, y + 92, [
    "智谱 GLM · SiliconFlow 免费档",
    "DeepSeek · MiMo(认证与参数已适配)",
    "本地反代:免 key,模型列表自动拉取",
    "自定义:任意 OpenAI 兼容端点",
])
notes(d, y + 16, [
    "「测试连接」真发请求,测的是正在填写的草稿",
    "LLM 不可用时自动降级本地规则,不阻塞",
])
footer(d, 3)
img.save("card-4.png")

# ---------- 卡 5 · 瘦身 + 界面 ----------
img, d = new_card(4)
brand(d, "v0.7.0 更新")
y = headline(d, 264, ["安装包再瘦身"])
d.text((M, y + 6), "105.5 → 99.5 MB", font=mob(88), fill=ACC)
y = bar(d, y + 128)
y += 52
y = bullets(d, y, [
    "语义推理组件按需下载,不用就永远不下",
    "检索全程离线:embedding 与推理都在本机",
    "插件分组折叠,默认只展开「核心数据」",
    "会话按项目折叠;没数据的 agent 不再占位",
])
notes(d, y + 16, ["升级不丢数据,Windows / Linux / macOS 自动更新直达"])
footer(d, 4)
img.save("card-5.png")

# ---------- 卡 6 · 项目简介(尾卡) ----------
img, d = new_card(5)
brand(d, "v0.7.0 更新")
y = headline(d, 264, ["MemorySQL 是什么?"])
y = bar(d, y + 28)
y += 48
d.text((M, y), "给 AI 编码 agent 装一个本地记忆库", font=yh(40), fill=MUT)
y = panel_rows(d, y + 92, [
    ("捕获", "12 家 agent 会话自动入库,原始文件只读"),
    ("检索", "SQLite 全文 + 语义检索,中文友好"),
    ("续接", "一句「续接 项目名」,上下文全量恢复"),
], h=158)
out_panel(d, y + 22, 168, [
    ("GitHub:github.com/Logic647/MemorySQL", 36, ACC),
    ("开源免费 · 三平台安装包 · 升级不丢数据", 32, MUT),
])
footer(d, 5)
img.save("card-6.png")

print("done: 6 cards ->", os.getcwd())
