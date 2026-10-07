"""
手绘风格图标生成器。

为什么不用 SVG：
    用户要求「必须是手绘大图像，必须是特别好看的线」。
    几何化的 SVG 线条死板、像图标库拼凑；手绘感需要笔触的不规则与呼吸感。
    因此这里用 Pillow 以 4 倍超采样绘制真实光栅图 PNG，边缘平滑、线条有机。

颜色策略：
    所有图标输出为「纯黑 + 透明背景」，前端用 CSS mask 加载，
    颜色由 currentColor 决定 —— 这样图标是独立图片文件，同时仍能跟随主题变色。
"""

import math
import os
import random

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets', 'icons')
SIZE = 128          # 输出边长
SS = 4              # 超采样倍数
CANVAS = SIZE * SS
_BASE_STROKE = 5.2 * SS   # 基础笔画粗细（超采样空间）
_BASE_WOBBLE = 0.0075     # 手绘抖动幅度，归一化坐标


# ---------- 绘图基础设施 ----------

class Pen:
    """手绘图笔：负责坐标变换、抖动、圆头线段绘制。"""

    # 基础笔画粗细（超采样空间）。放在类上，方法默认值才能正确解析。
    STROKE = _BASE_STROKE
    WOBBLE = _BASE_WOBBLE

    def __init__(self, img, seed):
        self.draw = ImageDraw.Draw(img, 'RGBA')
        # 同一 seed 保证多次构建结果完全一致
        self.rnd = random.Random(seed)

    def _p(self, x, y, jitter=True):
        """归一化坐标-> 画布坐标；可选加入手绘抖动"""
        if jitter:
            x += self.rnd.uniform(-self.WOBBLE, self.WOBBLE)
            y += self.rnd.uniform(-self.WOBBLE, self.WOBBLE)
        return (x * CANVAS, y * CANVAS)

    def stroke(self, pts, width=None, jitter=True, closed=False):
        """绘制一条手绘线条，自动加圆头"""
        width = self.STROKE if width is None else width
        seq = list(pts)
        if closed and seq:
            seq = seq + [seq[0]]
        # 端点不抖动，锚定形状；中间点抖动，产生手绘感
        p_first = self._p(*seq[0], jitter=False)
        p_last = self._p(*seq[-1], jitter=False)
        mid = [self._p(x, y, jitter=jitter) for x, y in seq[1:-1]]
        if len(seq) == 1:
            self.dot(seq[0][0], seq[0][1], width / 2, jitter=False)
            return
        all_pts = [p_first] + mid + [p_last]

        self.draw.line(all_pts, fill=(0, 0, 0, 255), width=int(round(width)), joint='curve')

        # 圆头：在线段两端补圆，让端点圆润
        r = width / 2
        for (cx, cy) in (all_pts[0], all_pts[-1]):
            self.draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 255))

    def dot(self, x, y, r, jitter=False):
        cx, cy = self._p(x, y, jitter=jitter)
        rr = r * CANVAS
        self.draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(0, 0, 0, 255))

    def curve(self, p0, c, p1, width=None, steps=26, jitter=True):
        """二次贝塞尔：手绘曲线的主力"""
        width = self.STROKE if width is None else width
        pts = []
        for i in range(steps + 1):
            t = i / steps
            mt = 1 - t
            x = mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0]
            y = mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1]
            pts.append((x, y))
        self.stroke(pts, width=width, jitter=jitter)

    def curve3(self, p0, c1, c2, p1, width=None, steps=32, jitter=True):
        """三次贝塞尔"""
        width = self.STROKE if width is None else width
        pts = []
        for i in range(steps + 1):
            t = i / steps
            mt = 1 - t
            x = mt**3 * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t**3 * p1[0]
            y = mt**3 * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t**3 * p1[1]
            pts.append((x, y))
        self.stroke(pts, width=width, jitter=jitter)

    def arc(self, cx, cy, r, a0, a1, width=None, steps=32, jitter=True):
        """圆弧（角度制）"""
        width = self.STROKE if width is None else width
        pts = []
        for i in range(steps + 1):
            a = math.radians(a0 + (a1 - a0) * i / steps)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        self.stroke(pts, width=width, jitter=jitter)

    def path(self, start, segments, width=None, steps=24, jitter=True, closed=False):
        """连续多段三次贝塞尔：手绘复杂轮廓的主力。

        segments: [(c1, c2, end), ...] 依次从当前点出发。
        端点锚定（不抖动），段内采样点轻微抖动，既有机的线条又不跑形。
        """
        width = self.STROKE if width is None else width
        pts = [start]
        cur = start
        for (c1, c2, end) in segments:
            sub = []
            for i in range(1, steps + 1):
                t = i / steps
                mt = 1 - t
                x = mt**3 * cur[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t**3 * end[0]
                y = mt**3 * cur[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t**3 * end[1]
                sub.append((x, y))
            pts.extend(sub)
            cur = end
        self.stroke(pts, width=width, jitter=jitter, closed=closed)


# ---------- 图标定义 ----------
# 每个函数接收 Pen，用 0~1 归一化坐标作画

def i_home(p):
    # 屋顶：一笔连续弧线，柔和而非折角
    p.curve3((0.15, 0.48), (0.30, 0.28), (0.50, 0.19), (0.85, 0.48), jitter=False)
    # 墙体：略带外张的手绘感
    p.path((0.26, 0.42), [((0.25, 0.55), (0.25, 0.68), (0.26, 0.84))], jitter=False)
    p.path((0.74, 0.42), [((0.75, 0.55), (0.75, 0.68), (0.74, 0.84))], jitter=False)
    p.stroke([(0.26, 0.84), (0.74, 0.84)], jitter=False)
    # 门：拱形顶
    p.path((0.41, 0.84), [((0.41, 0.72), (0.44, 0.65), (0.50, 0.64)),
                          ((0.56, 0.65), (0.59, 0.72), (0.59, 0.84))], jitter=False)


def i_plus(p):
    p.stroke([(0.50, 0.24), (0.50, 0.76)], jitter=False)
    p.stroke([(0.26, 0.51), (0.74, 0.51)], jitter=False)


def i_bell(p):
    # 钟身：两侧内收的曲线 + 圆润底沿
    p.path((0.23, 0.68), [((0.22, 0.42), (0.32, 0.27), (0.50, 0.27)),
                          ((0.68, 0.27), (0.78, 0.42), (0.77, 0.68))], jitter=False)
    # 底沿外翻
    p.path((0.23, 0.68), [((0.34, 0.74), (0.44, 0.76), (0.50, 0.76)),
                          ((0.56, 0.76), (0.66, 0.74), (0.77, 0.68))], jitter=False)
    # 顶部挂环
    p.arc(0.50, 0.19, 0.062, 200, 340, steps=16)
    # 铃舌
    p.arc(0.50, 0.83, 0.055, 15, 165, steps=16)


def i_user(p):
    p.arc(0.50, 0.33, 0.175, 0, 360, steps=44)
    # 肩线：连续弧，避免折角
    p.path((0.14, 0.88), [((0.16, 0.62), (0.30, 0.56), (0.50, 0.56)),
                          ((0.70, 0.56), (0.84, 0.62), (0.86, 0.88))])


def i_users(p):
    p.arc(0.37, 0.35, 0.145, 0, 360, steps=40)
    p.path((0.07, 0.82), [((0.09, 0.60), (0.21, 0.55), (0.37, 0.55)),
                          ((0.53, 0.55), (0.65, 0.60), (0.67, 0.82))])
    # 后方人物：只画右半边，形成层次
    p.arc(0.72, 0.40, 0.118, -78, 132, steps=28)
    p.path((0.83, 0.66), [((0.86, 0.72), (0.87, 0.76), (0.88, 0.82))])


def i_heart(p):
    # 经典心形：左右两个圆弧瓣 + 底部尖角，用连续贝塞尔一笔画完
    p.path((0.50, 0.80), [
        ((0.28, 0.64), (0.16, 0.50), (0.18, 0.36)),
        ((0.20, 0.20), (0.38, 0.14), (0.50, 0.30)),
        ((0.62, 0.14), (0.80, 0.20), (0.82, 0.36)),
        ((0.84, 0.50), (0.72, 0.64), (0.50, 0.80)),
    ])


def i_search(p):
    p.arc(0.44, 0.44, 0.27, 0, 360, steps=48)
    p.stroke([(0.64, 0.64), (0.84, 0.84)], jitter=False)


def i_send(p):
    # 纸飞机：闭合外轮廓（机头在左上）
    p.path((0.10, 0.22), [
        ((0.40, 0.19), (0.64, 0.16), (0.90, 0.13)),
        ((0.84, 0.46), (0.79, 0.66), (0.74, 0.88)),
        ((0.50, 0.66), (0.30, 0.44), (0.10, 0.22)),
    ], jitter=False)
    # 内折线：从机头到尾部中点，再折回，形成「机翼」
    p.stroke([(0.10, 0.22), (0.74, 0.88)], width=_BASE_STROKE * 0.75, jitter=False)
    p.stroke([(0.74, 0.88), (0.63, 0.55)], width=_BASE_STROKE * 0.75, jitter=False)
    p.stroke([(0.63, 0.55), (0.10, 0.22)], width=_BASE_STROKE * 0.75, jitter=False)


def i_close(p):
    p.path((0.29, 0.29), [((0.42, 0.42), (0.58, 0.58), (0.71, 0.71))])
    p.path((0.71, 0.29), [((0.58, 0.42), (0.42, 0.58), (0.29, 0.71))])


def i_chevron(p):
    p.path((0.40, 0.24), [((0.52, 0.38), (0.60, 0.50), (0.40, 0.76))])


def i_back(p):
    p.path((0.62, 0.24), [((0.50, 0.38), (0.42, 0.50), (0.62, 0.76))])


def i_share(p):
    p.dot(0.76, 0.22, 0.075)
    p.dot(0.76, 0.78, 0.075)
    p.dot(0.26, 0.50, 0.075)
    p.stroke([(0.33, 0.46), (0.69, 0.26)], jitter=False)
    p.stroke([(0.33, 0.54), (0.69, 0.74)], jitter=False)


def i_clock(p):
    p.arc(0.50, 0.50, 0.34, 0, 360, steps=48)
    p.stroke([(0.50, 0.28), (0.50, 0.51)], jitter=False)
    p.stroke([(0.50, 0.51), (0.66, 0.60)], jitter=False)


def i_chart(p):
    p.stroke([(0.20, 0.18), (0.20, 0.80), (0.84, 0.80)], jitter=False)
    p.stroke([(0.35, 0.68), (0.35, 0.52)], width=_BASE_STROKE * 1.15, jitter=False)
    p.stroke([(0.51, 0.68), (0.51, 0.36)], width=_BASE_STROKE * 1.15, jitter=False)
    p.stroke([(0.67, 0.68), (0.67, 0.24)], width=_BASE_STROKE * 1.15, jitter=False)


def i_star(p):
    pts = []
    for k in range(5):
        a = math.radians(-90 + k * 72)
        pts.append((0.50 + 0.36 * math.cos(a), 0.52 + 0.36 * math.sin(a)))
    inner = []
    for k in range(5):
        a = math.radians(-90 + k * 72 + 36)
        inner.append((0.50 + 0.155 * math.cos(a), 0.52 + 0.155 * math.sin(a)))
    order = []
    for k in range(10):
        order.append(pts[k // 2] if k % 2 == 0 else inner[k // 2])
    p.stroke(order, closed=True)


def i_flag(p):
    p.stroke([(0.28, 0.16), (0.28, 0.88)], jitter=False)
    p.curve3((0.28, 0.20), (0.50, 0.12), (0.62, 0.26), (0.76, 0.18))
    p.stroke([(0.76, 0.18), (0.76, 0.48)], jitter=False)
    p.curve3((0.76, 0.48), (0.62, 0.56), (0.50, 0.42), (0.28, 0.50))


def i_trash(p):
    p.stroke([(0.20, 0.26), (0.80, 0.26)], jitter=False)
    p.stroke([(0.40, 0.26), (0.40, 0.17), (0.60, 0.17), (0.60, 0.26)], jitter=False)
    p.curve3((0.27, 0.26), (0.28, 0.62), (0.28, 0.80), (0.28, 0.84))
    p.stroke([(0.28, 0.84), (0.72, 0.84)], jitter=False)
    p.curve3((0.72, 0.84), (0.72, 0.62), (0.72, 0.34), (0.73, 0.26))
    p.stroke([(0.44, 0.40), (0.44, 0.70)], width=_BASE_STROKE * 0.8, jitter=False)
    p.stroke([(0.56, 0.40), (0.56, 0.70)], width=_BASE_STROKE * 0.8, jitter=False)


def i_dots(p):
    p.dot(0.26, 0.50, 0.062)
    p.dot(0.50, 0.50, 0.062)
    p.dot(0.74, 0.50, 0.062)


def i_mic(p):
    # 胶囊形话筒：上下两段圆弧接成一体
    p.arc(0.50, 0.42, 0.20, 180, 360, steps=32)
    p.stroke([(0.30, 0.42), (0.30, 0.46)], jitter=False)
    p.stroke([(0.70, 0.42), (0.70, 0.46)], jitter=False)
    p.arc(0.50, 0.46, 0.20, 0, 180, steps=32)
    # 外部支架：圆弧开口
    p.arc(0.50, 0.46, 0.34, 20, 160, steps=28)
    p.stroke([(0.50, 0.80), (0.50, 0.90)], jitter=False)


def i_check(p):
    p.path((0.20, 0.53), [((0.32, 0.64), (0.42, 0.72), (0.50, 0.76)),
                          ((0.62, 0.68), (0.72, 0.50), (0.80, 0.30))], jitter=False)


def i_eye(p):
    # 杏仁形眼眶：上下对称连续贝塞尔
    p.path((0.13, 0.50), [
        ((0.28, 0.28), (0.72, 0.28), (0.87, 0.50)),
        ((0.72, 0.72), (0.28, 0.72), (0.13, 0.50)),
    ], jitter=False)
    p.arc(0.50, 0.50, 0.125, 0, 360, steps=32)


def i_edit(p):
    # 铅笔：笔身 + 笔尖
    p.stroke([(0.22, 0.80), (0.28, 0.62), (0.66, 0.22), (0.80, 0.36), (0.40, 0.76)], closed=True, jitter=False)
    p.stroke([(0.70, 0.16), (0.84, 0.30)], width=_BASE_STROKE * 0.85, jitter=False)
    p.stroke([(0.22, 0.80), (0.40, 0.76)], width=_BASE_STROKE * 0.85, jitter=False)


def i_logout(p):
    # 门框：完整圆角矩形（右侧留缺口给箭头）
    p.path((0.34, 0.17), [
        ((0.19, 0.17), (0.10, 0.30), (0.10, 0.50)),
        ((0.10, 0.70), (0.19, 0.83), (0.34, 0.83)),
        ((0.49, 0.83), (0.55, 0.80), (0.55, 0.74)),
    ], jitter=False)
    p.path((0.34, 0.17), [((0.49, 0.17), (0.55, 0.20), (0.55, 0.26))], jitter=False)
    # 出门箭头：从门内穿出
    p.stroke([(0.40, 0.50), (0.86, 0.50)], jitter=False)
    p.path((0.71, 0.30), [((0.80, 0.41), (0.87, 0.50), (0.71, 0.70))], jitter=False)


def i_download(p):
    p.stroke([(0.50, 0.14), (0.50, 0.56)], jitter=False)
    p.path((0.34, 0.40), [((0.42, 0.50), (0.50, 0.58), (0.66, 0.40))], jitter=False)
    # 托盘：柔和的碗形
    p.path((0.20, 0.68), [((0.22, 0.80), (0.32, 0.86), (0.50, 0.86)),
                          ((0.68, 0.86), (0.78, 0.80), (0.80, 0.68))], jitter=False)


def i_calendar(p):
    p.path((0.20, 0.30), [((0.20, 0.60), (0.20, 0.72), (0.20, 0.84)),
                          ((0.40, 0.84), (0.60, 0.84), (0.80, 0.84)),
                          ((0.80, 0.60), (0.80, 0.45), (0.80, 0.30))], jitter=False)
    p.stroke([(0.13, 0.30), (0.87, 0.30)], jitter=False)
    p.stroke([(0.34, 0.16), (0.34, 0.38)], width=_BASE_STROKE * 0.9, jitter=False)
    p.stroke([(0.66, 0.16), (0.66, 0.38)], width=_BASE_STROKE * 0.9, jitter=False)
    p.dot(0.36, 0.52, 0.045)
    p.dot(0.50, 0.52, 0.045)
    p.dot(0.64, 0.52, 0.045)
    p.dot(0.36, 0.68, 0.045)
    p.dot(0.50, 0.68, 0.045)


def i_tag(p):
    # 吊牌：左侧圆角 + 右侧尖角
    p.path((0.16, 0.14), [
        ((0.16, 0.30), (0.16, 0.70), (0.16, 0.86)),
        ((0.36, 0.86), (0.60, 0.86), (0.88, 0.58)),
        ((0.88, 0.42), (0.88, 0.30), (0.88, 0.14)),
        ((0.60, 0.14), (0.36, 0.14), (0.16, 0.14)),
    ], jitter=False)
    p.arc(0.31, 0.30, 0.055, 0, 360, steps=22)


def i_qr(p):
    p.stroke([(0.18, 0.18), (0.18, 0.44), (0.44, 0.44), (0.44, 0.18)], closed=True, jitter=False)
    p.stroke([(0.56, 0.18), (0.56, 0.44), (0.82, 0.44), (0.82, 0.18)], closed=True, jitter=False)
    p.stroke([(0.18, 0.56), (0.18, 0.82), (0.44, 0.82), (0.44, 0.56)], closed=True, jitter=False)
    p.dot(0.62, 0.62, 0.062)
    p.dot(0.80, 0.80, 0.062)
    p.stroke([(0.56, 0.78), (0.56, 0.82)], width=_BASE_STROKE * 1.6, jitter=False)
    p.stroke([(0.72, 0.56), (0.78, 0.56)], width=_BASE_STROKE * 1.6, jitter=False)


def i_sparkle(p):
    # 四角星：内凹半径调大一点，避免变成细长的菱形
    def star(cx, cy, r, ri, points=4):
        pts = []
        for k in range(points * 2):
            a = math.radians(-90 + k * (360 / (points * 2)))
            rad = r if k % 2 == 0 else ri
            pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
        return pts
    p.stroke(star(0.45, 0.54, 0.35, 0.115), closed=True, jitter=False)
    p.stroke(star(0.80, 0.21, 0.16, 0.052), closed=True, width=_BASE_STROKE * 0.72, jitter=False)


ICONS = {
    'home': i_home, 'plus': i_plus, 'bell': i_bell, 'user': i_user, 'users': i_users,
    'heart': i_heart, 'search': i_search, 'send': i_send, 'close': i_close,
    'chevron': i_chevron, 'back': i_back, 'share': i_share, 'clock': i_clock,
    'chart': i_chart, 'star': i_star, 'flag': i_flag, 'trash': i_trash, 'dots': i_dots,
    'mic': i_mic, 'check': i_check, 'eye': i_eye, 'edit': i_edit, 'logout': i_logout,
    'download': i_download, 'calendar': i_calendar, 'tag': i_tag, 'qr': i_qr,
    'sparkle': i_sparkle,
}


def render(name, fn):
    img = Image.new('RGBA', (CANVAS, CANVAS), (255, 255, 255, 0))
    pen = Pen(img, seed=sum(ord(ch) * (i + 1) for i, ch in enumerate(name)))
    fn(pen)
    # 缩小到目标尺寸，实现抗锯齿
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    path = os.path.join(OUT_DIR, name + '.png')
    img.save(path, 'PNG', optimize=True)
    return path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, fn in ICONS.items():
        path = render(name, fn)
        size = os.path.getsize(path)
        print('  %-10s %5d B' % (name + '.png', size))
    print('\n共生成 %d 个手绘图标 -> %s' % (len(ICONS), os.path.abspath(OUT_DIR)))


if __name__ == '__main__':
    main()