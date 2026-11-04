// 临时二维码看板：本机 8765 端口，只读 NapCat 的二维码文件，每 2 秒自动换新码。
// 为什么不用 file:// 页面：浏览器会拦本地文件，直接开图片又不会自动换码。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const QR = path.join(os.homedir(), '.dsh', 'napcat', 'napcat', 'cache', 'qrcode.png')
const PORT = 8765

const page = `<!doctype html><meta charset="utf-8">
<title>某只鱼 · QQ 登录</title>
<body style="margin:0;background:#fff;font-family:system-ui,sans-serif;text-align:center">
<h2 style="margin:16px 0 4px">某只鱼（2680603386）· QQ 登录</h2>
<p style="color:#666;margin:4px 0 12px">用登录「某只鱼」的手机 QQ 扫码；每 2 秒自动换新码</p>
<img id="q" style="width:294px;height:294px;image-rendering:pixelated;border:1px solid #eee" alt="二维码">
<p id="st" style="color:#999;font-size:13px"></p>
<script>
const q = document.getElementById('q'), st = document.getElementById('st')
function tick(){
  q.src = '/qr?t=' + Date.now()
  st.textContent = new Date().toLocaleTimeString() + ' 已刷新'
}
tick(); setInterval(tick, 2000)
</script>`

let lastGood = null
const server = http.createServer((req, res) => {
  const url = String(req.url || '/')
  if (url.startsWith('/qr')) {
    fs.readFile(QR, (e, buf) => {
      // NapCat 换码的瞬间可能读到半截文件：只认完整 PNG，否则退上一次好图
      const ok = !e && buf && buf.length > 300 && buf[0] === 0x89 && buf[1] === 0x50
      if (ok) lastGood = buf
      const out = ok ? buf : lastGood
      if (!out) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('二维码暂时没有生成'); return }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store, no-cache, must-revalidate' })
      res.end(out)
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(page)
})
server.listen(PORT, '127.0.0.1', () => console.log('qr board: http://127.0.0.1:' + PORT + '/'))
