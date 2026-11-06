for t in ['喜欢','截止 ','更早','待批 ','入库 ','得分','本月 tokens','本月 tokens ']:
    print(ascii(t), ascii(t.encode('utf-8').decode('gbk', errors='replace')))
