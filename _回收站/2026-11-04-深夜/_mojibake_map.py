cands = list('★☆◆◇▼▾▲△↑↓⁺⁻·—…πσ▲▼▶◀') + ['▸','▪','◇','●','○','■','□']
for c in cands:
    try:
        m = c.encode('utf-8').decode('gbk', errors='replace')
    except Exception as e:
        m = 'ERR '+str(e)
    print(ascii(c), ascii(m))
