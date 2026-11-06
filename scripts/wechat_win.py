# -*- coding: utf-8 -*-
"""微信窗口兜底：没窗口就把客户端拉起来。

微信关到托盘 / 被关掉之后，自动化读不到主窗口，`WeChatGUI()` 会抛
「未找到微信主窗口」。发消息和「正在输入」都得先有窗口，所以这里统一兜一下：
先试一次；失败就 start 可执行文件，等最多 25 秒再试。

可执行文件顺序：环境变量 DSHC_WECHAT_EXE → 常见安装路径。
"""
import os
import subprocess
import time

DEFAULT_EXES = [
    r'D:\Tencent\Weixin\Weixin.exe',
    r'C:\Program Files\Tencent\Weixin\Weixin.exe',
    r'C:\Program Files\Tencent\WeChat\WeChat.exe',
    r'C:\Program Files (x86)\Tencent\WeChat\WeChat.exe',
]


def _exe():
    env = os.environ.get('DSHC_WECHAT_EXE')
    if env and os.path.exists(env):
        return env
    for p in DEFAULT_EXES:
        if os.path.exists(p):
            return p
    return ''


def ensure_gui(timeout=25):
    """返回一个能用的 WeChatGUI；实在起不来就把最后一次异常抛出去。"""
    from wechatauto import WeChatGUI  # type: ignore

    try:
        return WeChatGUI()
    except Exception as first:  # noqa: BLE001
        exe = _exe()
        if not exe:
            raise first
        try:
            subprocess.Popen([exe])
        except Exception:  # noqa: BLE001
            raise first
        t0 = time.time()
        last = first
        while time.time() - t0 < timeout:
            time.sleep(1.0)
            try:
                return WeChatGUI()
            except Exception as e:  # noqa: BLE001
                last = e
        raise last


if __name__ == '__main__':
    # 开机预热：没人催的时候先把微信窗口拉起来，之后回话就不用现拉（那一下要几十秒）。
    import sys as _sys
    try:
        ensure_gui()
        _sys.stdout.write('ok')
    except Exception as e:  # noqa: BLE001
        _sys.stderr.write(str(e)[:300])
        _sys.exit(1)
