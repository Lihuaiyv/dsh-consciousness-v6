# -*- coding: utf-8 -*-
"""一块很朴素的画板。

它不生成任何东西：只存「落笔 → 抬笔」这一串坐标，然后把它们画出来。
我用它画画，唯一的权力就是给铅笔一串坐标。

用法：
  python board.py new                      # 清空，开一张新纸
  python board.py stroke "<json>"          # 画一条线（一次落笔到抬笔）
  python board.py apply ops.json [--delay 0.12]   # 按顺序画很多条线，画一条刷一次
  python board.py render                   # 重新出图
  python board.py undo                     # 撤掉最后一条线
  python board.py status                   # 现在画了多少笔

stroke 的 json：
  {"pts": [[x, y], ...], "w": 4, "c": [40, 40, 46], "a": 1.0, "erase": false}
  pts 是铅笔经过的点（像素坐标），w 是笔尖粗细，c 是颜色，a 是不透明度。
"""
import json
import os
import sys
import time

# 控制台默认是 GBK，中文会糊成乱码；统一按 UTF-8 说。
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
# 画和状态不放在仓库里：默认落在 ~/.dsh/paintboard，测试可以用 PAINTBOARD_HOME 指到别处。
DATA = os.environ.get('PAINTBOARD_HOME') or os.path.join(os.path.expanduser('~'), '.dsh', 'paintboard')
os.makedirs(DATA, exist_ok=True)
STATE = os.path.join(DATA, 'board.json')
PNG = os.path.join(DATA, 'board.png')
SS = 2  # 超采样，让线不要太糙

PAPER = (252, 250, 246)


def blank(w=900, h=900):
    return {'w': w, 'h': h, 'paper': list(PAPER), 'strokes': []}


def load():
    if not os.path.exists(STATE):
        return blank()
    with open(STATE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save(state):
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


def draw_stroke(img, s):
    pts = [(float(p[0]), float(p[1])) for p in s.get('pts') or []]
    if not pts:
        return
    w = max(0.3, float(s.get('w', 3)))
    c = tuple(s.get('c') or [40, 40, 46])
    a = s.get('a')
    a = 1.0 if a is None else max(0.0, min(1.0, float(a)))
    if s.get('erase'):
        c = tuple(state_paper)
    color = (c[0], c[1], c[2], int(255 * a))
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    # 笔压：ws 给每个点一个宽度，线就会中间粗两头细，像真的压下去又抬起来。
    ws = s.get('ws')
    if not (isinstance(ws, list) and len(ws) == len(pts)):
        ws = [w] * len(pts)
    if len(pts) == 1:
        r = max(0.3, float(ws[0])) / 2
        ld.ellipse([(pts[0][0] - r) * SS, (pts[0][1] - r) * SS,
                    (pts[0][0] + r) * SS, (pts[0][1] + r) * SS], fill=color)
    else:
        for i in range(len(pts) - 1):
            x0, y0 = pts[i]
            x1, y1 = pts[i + 1]
            ww = (float(ws[i]) + float(ws[i + 1])) / 2
            ld.line([x0 * SS, y0 * SS, x1 * SS, y1 * SS], fill=color, width=max(1, int(ww * SS)))
        for i, (x, y) in enumerate(pts):
            r = max(0.3, float(ws[i])) / 2
            ld.ellipse([(x - r) * SS, (y - r) * SS, (x + r) * SS, (y + r) * SS], fill=color)
    img.alpha_composite(layer)
    return img


def render(state=None):
    state = state or load()
    global state_paper
    state_paper = tuple(state.get('paper') or PAPER)
    img = Image.new('RGBA', (state['w'] * SS, state['h'] * SS), tuple(PAPER) + (255,))
    for s in state.get('strokes', []):
        draw_stroke(img, s)
    out = img.convert('RGB').resize((state['w'], state['h']), Image.LANCZOS)
    out.save(PNG)
    return PNG


def cmd_new(args):
    w = int(args[0]) if args else 900
    h = int(args[1]) if len(args) > 1 else w
    save(blank(w, h))
    render()
    print('新纸 %dx%d' % (w, h))


def cmd_stroke(args):
    state = load()
    s = json.loads(args[0])
    state['strokes'].append(s)
    save(state)
    render(state)
    print('第 %d 笔' % len(state['strokes']))


def cmd_apply(args):
    state = load()
    ops = json.load(open(args[0], 'r', encoding='utf-8-sig'))
    delay = 0.0
    if '--delay' in args:
        delay = float(args[args.index('--delay') + 1])
    n = 0
    for s in ops:
        state['strokes'].append(s)
        save(state)
        render(state)
        n += 1
        if delay:
            time.sleep(delay)
    print('画完 %d 笔，共 %d 笔' % (n, len(state['strokes'])))


def cmd_undo(args):
    state = load()
    if state['strokes']:
        state['strokes'].pop()
        save(state)
        render(state)
    print('剩 %d 笔' % len(state['strokes']))


def cmd_status(args):
    state = load()
    print('尺寸 %dx%d，%d 笔，纸 %s' % (state['w'], state['h'], len(state['strokes']), PNG))


def cmd_render(args):
    print(render())


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    rest = sys.argv[2:]
    {'new': cmd_new, 'stroke': cmd_stroke, 'apply': cmd_apply,
     'undo': cmd_undo, 'status': cmd_status, 'render': cmd_render}.get(cmd, cmd_status)(rest)





