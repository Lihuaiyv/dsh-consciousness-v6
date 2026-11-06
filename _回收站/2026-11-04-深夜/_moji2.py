for t in ['尚未立论','尚未立言','尚未定型','带几轮历史','条记忆','意识','三观','星','已','未']:
    print(ascii(t), ascii(t.encode('utf-8').decode('gbk', errors='replace')))
