# -*- coding: utf-8 -*-
"""微信收信：只读本地库，把「比水位新的消息」捞出来，JSON 交给 Node。

为什么不用窗口：微信 4.x 是自绘界面，UIA 读不到消息列表；而本地库能解密、能按会话读。
这条路一次都不动窗口，也不点任何东西——收信不该打扰她。

用法：python wechat-inbox.py <request.json> <result.json>
请求：{
  "chats": ["filehelper", "<group>@chatroom"] | null,   # null = 最近有消息的所有会话
  "limit": 40,                                          # 每个会话最多读多少条（只用来兜住水位）
  "seen": {"<username>": <sort_seq>}                    # 已经记到哪儿了（毫秒水位）
}
返回：{
  "ok": true, "self": "<自己的 wxid>",
  "chats": [{"username", "name", "messages": [{"id","sort_seq","at","self","sender","type","text"}]}],
  "note": ""
}

纪律：
  1) 只读。不开窗、不发消息、不改库。
  2) 非文本给占位符，别把 XML 原文灌进记忆。
  3) 一条消息的身份用 sort_seq（毫秒、跨分片可比）；local_id 会跨分片重号，不能单独当 id。
"""
import json
import sys
from datetime import datetime, timezone


def save(path, out):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)


# 只把「人说的是话」的类型当正文；其余给占位符。
TEXT_TYPES = ('文本', '引用')
# 这些不是谁说的话：系统提示（加了谁、撤回、时间线）不进账本。
SKIP_TYPES = ('系统消息', '撤回', '时间', '消息撤回', '撤回消息')
PLACEHOLDER = {
    '图片': '[图片]',
    '语音': '[语音]',
    '视频': '[视频]',
    '文件': '[文件]',
    '动画表情': '[表情]',
    '链接': '[链接]',
    '位置': '[位置]',
    '转账': '[转账]',
    '红包': '[红包]',
    '音视频通话': '[通话]',
    '名片': '[名片]',
    '引用消息': '[引用]',
}


def iso_of(sec):
    try:
        t = int(sec)
    except (TypeError, ValueError):
        t = 0
    if t <= 0:
        return ''
    return datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def main():
    req_path, res_path = sys.argv[1], sys.argv[2]
    with open(req_path, encoding='utf-8-sig') as f:
        req = json.load(f)

    out = {'ok': False, 'self': '', 'chats': [], 'note': ''}

    try:
        from wechatauto import WeChatDB  # type: ignore
    except Exception as e:  # noqa: BLE001
        out['note'] = '没装 wechatauto-replica：pip install wechatauto-replica（%s）' % str(e)[:120]
        save(res_path, out)
        return

    try:
        db = WeChatDB()
    except Exception as e:  # noqa: BLE001
        out['note'] = '读不了微信本地库：%s' % str(e)[:300]
        save(res_path, out)
        return

    # 自己的 wxid：「这条是不是我发的」只认它，不认 sender_id == 2 那种写死的号。
    me = str(getattr(db, 'wxid', '') or '')

    # 会话名在这里拿（显示名要写进 conversation_id，别用 wxid 冒充）
    meta = {}
    try:
        for c in db.list_message_chats():
            u = str(c.get('username') or '')
            if u:
                meta[u] = {'name': str(c.get('name') or u), 'count': int(c.get('message_count') or 0)}
    except Exception as e:  # noqa: BLE001
        out['note'] = '列会话失败：%s' % str(e)[:200]

    chats = req.get('chats')
    if not chats:
        # 没指定就只碰「确实有消息」的会话，省得每个空会话都去开一次库
        chats = [u for u, m in meta.items() if m.get('count', 0) > 0]
    limit = int(req.get('limit') or 40)
    seen = req.get('seen') or {}

    for who in chats:
        who = str(who)
        item = {'username': who, 'name': (meta.get(who) or {}).get('name') or who, 'messages': []}
        try:
            rows = db.get_messages(who, limit=limit)
        except Exception as e:  # noqa: BLE001
            item['error'] = str(e)[:200]
            out['chats'].append(item)
            continue
        floor = int(seen.get(who) or 0)
        for r in rows or []:
            try:
                seq = int(r.get('sort_seq') or 0)
            except (TypeError, ValueError):
                seq = 0
            if seq <= floor:
                continue
            typ = str(r.get('type') or '')
            if typ in SKIP_TYPES:
                continue
            text = str(r.get('content') or '')
            if typ not in TEXT_TYPES:
                text = PLACEHOLDER.get(typ, ('[%s]' % typ) if typ else '')
            if not text.strip():
                continue
            sender = str(r.get('sender_username') or '')
            item['messages'].append({
                'id': str(seq) if seq else str(r.get('local_id') or ''),
                'sort_seq': seq,
                'at': iso_of(r.get('create_time')),
                'self': bool(me and sender == me),
                'sender': sender,
                'type': typ,
                'text': text,
            })
        out['chats'].append(item)

    out['ok'] = True
    out['self'] = me
    save(res_path, out)


if __name__ == '__main__':
    main()
