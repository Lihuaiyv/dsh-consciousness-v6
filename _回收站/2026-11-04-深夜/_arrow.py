print(ascii('\u9231'.encode('gbk')))
for c in ['⌃','⌄','▴','▾','˄','˅','︿','﹀','∧','∨','△','▽','⌵','⌆']:
    print(ascii(c), ascii(c.encode('utf-8').decode('gbk',errors='replace')))
