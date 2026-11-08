// 出声 · 看字节：回来的东西到底是不是音频。
//
// 为什么不信配置：三条路的「格式」是配置里写的，但真正回来的是字节。
// 服务挂掉时常塞回一段 HTML 错误页，拿它当 mp3 发出去，主人听到的是一片安静，
// 日志里却写着「成功」。所以交出去之前先看一眼头几个字节。
//
// 纯函数，不碰网络。

/**
 * @param {Buffer} buffer
 * @returns {'mp3'|'wav'|null}
 */
export function sniffAudioFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  // ID3v2 标签，或直接以 MPEG 帧同步开头（0xFF 后三位是 1）。
  if (buffer.toString('ascii', 0, 3) === 'ID3') return 'mp3'
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && buffer.length > 128) return 'mp3'
  return null
}
