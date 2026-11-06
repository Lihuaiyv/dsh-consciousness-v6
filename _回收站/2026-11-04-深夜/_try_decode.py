import re
for s in ['\u704f\u6c2d\u6e6d\u7ed4\u5b2d', '\u752f\ufe40\u5691\u675b', '\u5dfb', '\u9359']:
    for enc in ['gbk','gb18030']:
        try:
            b=s.encode(enc)
            print(ascii(s), enc, b.hex(), '=>', ascii(b.decode('utf-8')))
        except Exception as e:
            print(ascii(s), enc, 'ERR', e)
