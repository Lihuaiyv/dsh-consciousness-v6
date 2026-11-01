# -*- coding: utf-8 -*-
"""个人微信 Python 后端：调 wechatauto-replica 发送一条文本。

微信 4.1 的聊天界面是自绘的，冷启动 UIAutomation 只暴露 Qt 空壳；
wechatauto-replica 会热激活 Qt accessibility gate，再用 UIA 优先 / OCR 兜底发送。
这个脚本只在装了该包时生效，未安装会返回 WECHATAUTO_MISSING，由 Node 侧退回 UIA。

用法：python wechat-send.py <request.json> <result.json>
"""
import json
import sys
import traceback
from datetime import datetime


def save(path, out):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)


def main():
    req_path, res_path = sys.argv[1], sys.argv[2]
    with open(req_path, encoding='utf-8') as f:
        req = json.load(f)

    out = {
        'ok': False,
        'mode': 'wechatauto',
        'code': None,
        'message': '',
        'target': str(req.get('target') or ''),
        'sent': False,
        'steps': [],
        'at': datetime.now().isoformat(),
    }

    try:
        from wechatauto.guia import quick_send  # type: ignore
    except Exception as e:  # noqa: BLE001
        out['code'] = 'WECHATAUTO_MISSING'
        out['message'] = (
            '没装 wechatauto-replica（%s）。安装：pip install wechatauto-replica；'
            '发送路径还需要 winsdk、pypinyin。' % str(e)[:120]
        )
        save(res_path, out)
        return

    target = str(req.get('target') or '').strip()
    text = str(req.get('text') or '')
    if not target:
        out['code'] = 'WECHAT_NO_TARGET'
        out['message'] = '收件人为空'
        save(res_path, out)
        return
    if not text.strip():
        out['code'] = 'WECHAT_NO_TEXT'
        out['message'] = '消息正文为空'
        save(res_path, out)
        return

    try:
        # 不同版本 quick_send 的参数名可能不同，先按 v1.2 的 who= 调，失败再退回位置参数
        try:
            quick_send(text=text, who=target, verify=True)
        except TypeError:
            quick_send(text, target, verify=True)
        out['ok'] = True
        out['sent'] = True
        out['message'] = '已发送给「%s」' % target
    except Exception as e:  # noqa: BLE001
        out['code'] = 'WECHATAUTO_FAILED'
        out['message'] = str(e)[:600]
        out['trace'] = traceback.format_exc()[-1500:]

    save(res_path, out)


if __name__ == '__main__':
    main()
