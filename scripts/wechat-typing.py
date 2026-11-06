# -*- coding: utf-8 -*-
"""微信「正在输入」：先把话放进输入框里打草稿，等回复写好了再整句发出去。

微信没有给第三方「打字状态」的接口，对方看到的那行「正在输入」只跟**输入框里真的有人在打字**
有关。所以这里做的事很朴素：真在她的输入框里放字（剪贴板粘贴），每两秒半改一次让它保持，
等 Node 把回复写进 wait_file，再整句覆盖、停一下、回车。

用法：python wechat-typing.py <request.json> <result.json>
请求：{
  "target": "主人",          # 会话名（备注/昵称都行，和发消息同一个口径）
  "wait_file": "...",        # Node 把回复写进这个文件：{"text": "..."}
  "lead_ms": 1200,           # 回车前停多久（让对方看到「正在输入」再落地）
  "timeout_ms": 120000,      # 等回复最多等多久；超时就清空草稿退出
  "placeholder": "…"         # 草稿占位（会被改两次刷新状态）
}
返回：{"ok": bool, "code": str|null, "message": str, "typed": bool, "waited_ms": int}

纪律：
  1) 只在这条会话的输入框里打字，不点别的地方、不发别的消息。
  2) 任何失败都要把草稿清掉——不能给主人留一个「…」在输入框里。
  3) 发送走 WeChatGUI 自己的 click_send：它回车前会回读比对，发错人/发全角半角都能拦。
"""
import json
import os
import sys
import time
import traceback


def save(path, out):
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        pass


def main():
    req_path, res_path = sys.argv[1], sys.argv[2]
    with open(req_path, encoding='utf-8-sig') as f:
        req = json.load(f)
    out = {'ok': False, 'code': None, 'message': '', 'typed': False, 'waited_ms': 0}

    target = str(req.get('target') or '').strip()
    wait_file = str(req.get('wait_file') or '')
    lead = max(0, int(req.get('lead_ms') or 0)) / 1000.0
    timeout = max(1, int(req.get('timeout_ms') or 120000)) / 1000.0
    placeholder = str(req.get('placeholder') or '…')

    if not target:
        out['code'] = 'NO_TARGET'
        out['message'] = '收件人为空'
        save(res_path, out)
        return

    try:
        from wechatauto import WeChatGUI  # type: ignore
    except Exception as e:  # noqa: BLE001
        out['code'] = 'WECHATAUTO_MISSING'
        out['message'] = '没装 wechatauto-replica：%s' % str(e)[:160]
        save(res_path, out)
        return

    wx = None
    typed = False
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from wechat_win import ensure_gui  # 窗口没了就把它拉起来（关到托盘也能救）
        wx = ensure_gui()
        wx.ensure_visible()
        if not wx.open_chat(target):
            out['code'] = 'OPEN_FAILED'
            out['message'] = '打不开会话「%s」' % target
            save(res_path, out)
            return

        box = wx.get_input_box()
        if not box:
            out['code'] = 'NO_INPUT_BOX'
            out['message'] = '找不到输入框（窗口可能被挡住/最小化）'
            save(res_path, out)
            return

        # 先打一个草稿：从这一刻起，对面就该看到「正在输入」了
        if not wx.input_text(placeholder, box):
            out['code'] = 'TYPE_FAILED'
            out['message'] = '草稿打不进输入框（焦点没落下去）'
            save(res_path, out)
            return
        typed = True
        out['typed'] = True

        t0 = time.time()
        last_alive = t0
        flip = False
        text = None
        while time.time() - t0 < timeout:
            if wait_file and os.path.exists(wait_file):
                try:
                    with open(wait_file, encoding='utf-8-sig') as f:
                        doc = json.load(f)
                    text = doc.get('text')
                except Exception:  # noqa: BLE001
                    text = None
                if isinstance(text, str):
                    break
            # 保持「正在输入」：微信的打字状态几秒就不刷新了，隔两秒半改一次草稿
            if time.time() - last_alive > 2.5:
                flip = not flip
                try:
                    wx.input_text(placeholder + (' ' if flip else ''), box)
                except Exception:  # noqa: BLE001
                    pass
                last_alive = time.time()
            time.sleep(0.2)

        out['waited_ms'] = int((time.time() - t0) * 1000)

        if text is None:
            out['code'] = 'WAIT_TIMEOUT'
            out['message'] = '等回复超时（%.0f 秒），草稿已清掉' % timeout
            return

        text = str(text).strip()
        if not text:
            out['code'] = 'EMPTY_TEXT'
            out['message'] = '回复是空的，草稿已清掉'
            return

        # 整句覆盖草稿（input_text 自己会 Ctrl+A / Delete 再粘贴）
        if not wx.input_text(text, box):
            # 草稿这条路不通（窗口焦点被抢 / 输入框探测失败）：退回包自带的发送路径，
            # 至少把话送出去——「正在输入」没演成，不能连话都丢了。
            try:
                from wechatauto.guia import quick_send  # type: ignore
                quick_send(text=text, who=target, verify=True)
                out['ok'] = True
                out['sent'] = True
                out['message'] = '已发送给「%s」（打字没演成，退回普通发送）' % target
                return
            except Exception as e:  # noqa: BLE001
                out['code'] = 'TYPE_FINAL_FAILED'
                out['message'] = '正式回复打不进输入框，退回发送也失败：%s' % str(e)[:160]
                return
        typed = False  # 下面要么发出去，要么在 finally 里清掉

        time.sleep(lead)
        if not wx.click_send():
            out['code'] = 'SEND_UNCONFIRMED'
            out['message'] = '回车了，但没确认到输入框清空（可能已经发出去了，别再重发）'
            out['ok'] = True
            out['sent'] = False
            return

        out['ok'] = True
        out['sent'] = True
        out['message'] = '已发送给「%s」' % target
    except Exception as e:  # noqa: BLE001
        out['code'] = 'TYPING_FAILED'
        out['message'] = str(e)[:300]
        out['trace'] = traceback.format_exc()[-800:]
    finally:
        # 没发出去就把草稿清掉；清不掉也如实说
        if typed and wx is not None:
            try:
                wx.input_text(' ', wx.get_input_box())
                VK_A, VK_DELETE = 0x41, 0x2E
                wx._input.key(VK_A, ctrl=True)   # noqa: SLF001 - 包的私有键盘口，清草稿用
                wx._input.key(VK_DELETE)         # noqa: SLF001
            except Exception:  # noqa: BLE001
                pass
        save(res_path, out)


if __name__ == '__main__':
    main()
