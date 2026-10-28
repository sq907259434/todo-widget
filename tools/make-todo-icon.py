#!/usr/bin/env python3
"""生成待办清单（TodoCard）的应用图标 icon.png（1024x1024）。

风格与天气卡片的图标配套：同样的圆角方形 + 柔和竖向渐变，
但底色换成绿色系、主体换成"清单板 + 打勾"，一眼就能和天气区分开。
4x 超采样抗锯齿，最后缩回 1024。

用法：python tools/make-todo-icon.py   （输出到项目根 icon.png）
"""
import os
from PIL import Image, ImageDraw

S = 4096          # 超采样画布
OUT = 1024        # 最终尺寸
CORNER = int(S * 0.22)   # 圆角半径，和天气图标观感一致


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_gradient_bg(draw, top, bottom):
    """圆角方形 + 自上而下渐变：逐行画横线，两端按圆角内缩。"""
    for y in range(S):
        t = y / (S - 1)
        c = lerp(top, bottom, t)
        # 该行圆角内缩量（圆方程）
        if y < CORNER:
            dx = CORNER - (CORNER ** 2 - (CORNER - y) ** 2) ** 0.5
        elif y > S - CORNER:
            dy = y - (S - CORNER)
            dx = CORNER - (CORNER ** 2 - dy ** 2) ** 0.5
        else:
            dx = 0
        draw.line([(dx, y), (S - dx, y)], fill=c)


def main():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景：绿色渐变（顶浅底深），和天气的蓝底呼应但一眼可区分
    rounded_gradient_bg(d, (66, 199, 129), (28, 156, 92))

    # ---- 白色清单板（带一点点投影感：先画一块深色偏移，再画白板） ----
    board_l, board_t, board_r, board_b = int(S*0.20), int(S*0.16), int(S*0.80), int(S*0.86)
    bc = int(S * 0.075)
    shadow_off = int(S * 0.018)
    d.rounded_rectangle([board_l + shadow_off, board_t + shadow_off,
                         board_r + shadow_off, board_b + shadow_off],
                        radius=bc, fill=(20, 110, 66, 110))          # 柔影
    d.rounded_rectangle([board_l, board_t, board_r, board_b],
                        radius=bc, fill=(255, 255, 255, 255))

    # 板子顶上的夹子（绿色小圆角条）
    clip_w, clip_h = int(S * 0.24), int(S * 0.075)
    cx0 = (board_l + board_r - clip_w) // 2
    d.rounded_rectangle([cx0, board_t - clip_h // 2, cx0 + clip_w, board_t + clip_h // 2 + int(S*0.01)],
                        radius=int(clip_h * 0.45), fill=(46, 173, 108, 255))

    # ---- 三行清单：绿勾、绿勾、橙勾（最后一行呼应天气的太阳橙） ----
    rows_y = [0.36, 0.545, 0.73]           # 相对板高的行中心
    row_r = int(S * 0.052)                 # 圆圈半径
    circle_cx = board_l + int(S * 0.115)
    bar_x0 = circle_cx + row_r + int(S * 0.055)
    bar_x1 = board_r - int(S * 0.10)
    check_colors = [(42, 173, 106), (42, 173, 106), (245, 166, 35)]
    bar_colors = [(210, 216, 213), (210, 216, 213), (210, 216, 213)]

    for ry, cc, bcol in zip(rows_y, check_colors, bar_colors):
        cy = board_t + int((board_b - board_t) * ry)
        # 圆圈
        d.ellipse([circle_cx - row_r, cy - row_r, circle_cx + row_r, cy + row_r],
                  fill=cc + (255,))
        # 白色对勾（两段粗线）
        k = row_r * 0.52
        w = max(6, int(S * 0.016))
        d.line([(circle_cx - k * 0.9, cy + k * 0.05), (circle_cx - k * 0.15, cy + k * 0.75)],
               fill=(255, 255, 255, 255), width=w)
        d.line([(circle_cx - k * 0.15, cy + k * 0.75), (circle_cx + k * 0.95, cy - k * 0.65)],
               fill=(255, 255, 255, 255), width=w)
        # 文本条（圆角长条）
        bh = int(S * 0.042)
        d.rounded_rectangle([bar_x0, cy - bh // 2, bar_x1, cy + bh // 2],
                            radius=bh // 2, fill=bcol + (255,))

    out = img.resize((OUT, OUT), Image.LANCZOS)
    path = os.path.join(os.path.dirname(__file__), "..", "icon.png")
    out.save(os.path.abspath(path), "PNG")
    print("OK", os.path.abspath(path))


if __name__ == "__main__":
    main()
