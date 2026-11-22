WPR 文件 IO 抓取（2026-11-22）

目的：卡死的时候，把「哪个进程读了哪个文件」记下来。进程计数器只能看到「谁读了多少」，
看不到「读了哪个文件」；WPR 是 Windows 自带的文件 IO 跟踪，能到文件级，不用装任何东西。

两步：

1. 开记录（需要管理员）
   Win+X → 「终端(管理员)」→ 运行：
   powershell -ExecutionPolicy Bypass -File "D:\deepseek_local\plugins\dsh-consciousness-v6\scripts\freeze-capture\start.ps1"

   看到「已开始」就可以关窗口，记录在系统里继续跑。开销很小。

2. 卡死后重启，保存记录（同样需要管理员）
   powershell -ExecutionPolicy Bypass -File "D:\deepseek_local\plugins\dsh-consciousness-v6\scripts\freeze-capture\stop.ps1"

   会生成 D:\deepseek_local\plugins\scratch\freeze.etl

3. 把 ETL 存好之后告诉小汐，由她把 ETL 导成 CSV，按「文件名 + 读字节数」排出来，
   就能看到卡死那段时间究竟是哪个进程在读哪个文件。

注意：
- 记录期间如果一直不卡，也可以一直开着，不影响日常使用。
- 不想记了：管理员窗口跑 wpr -cancel
- ETL 文件不自动删，抓完可以让小汐清掉。
