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


def _login_window():
    """微信是不是停在登录窗（mmui::LoginWindow / ...Login...）。"""
    try:
        import uiautomation as auto  # 随包一起装的
        for w in auto.GetRootControl().GetChildren():
            try:
                cls = str(getattr(w, 'ClassName', '') or '')
                nm = str(getattr(w, 'Name', '') or '')
                if 'Login' in cls or ('登录' in nm and '微信' in nm):
                    return True
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        return False
    return False


def _running():
    """Weixin.exe 在不在跑（在跑就绝不能再去 start 一个：第二实例会弹登录窗）。"""
    try:
        r = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Weixin.exe'],
                           capture_output=True, text=True, encoding='gbk', errors='replace', timeout=10)
        return 'Weixin.exe' in (r.stdout or '')
    except Exception:  # noqa: BLE001
        return False


def ensure_gui(timeout=25):
    """返回一个能用的 WeChatGUI；实在起不来就把最后一次异常抛出去。"""
    from wechatauto import WeChatGUI  # type: ignore

    # 登录窗也是「窗口」：WeChatGUI() 会把它当主窗收下，然后发消息发进登录框里。
    # 所以先看一眼，停在登录窗就直接说清楚，别硬起进程。
    if _login_window():
        raise RuntimeError('微信停在登录窗（mmui::LoginWindow）：手机上确认登录后再试')

    try:
        return WeChatGUI()
    except Exception as first:  # noqa: BLE001
        # 关键：进程在、只是窗口缩在托盘里时，再 start 一次等于开第二个实例——那会弹登录窗。
        if _running():
            raise RuntimeError('微信进程在，但主窗口打不开（缩在托盘里）；点开托盘图标再试，别重启进程')
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
