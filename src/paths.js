/**
 * 路径的唯一出处：别处不要再写死 `C:\Users\xxx` 或 `D:\deepseek\...`。
 *
 * 为什么要有它：2026-11-08 重装，用户从 ygys1 变成 l，仓库从 D:\deepseek\dsh-plugins
 * 搬到 D:\deepseek_local\plugins，十几个脚本里写死的库路径当场全指错地方——不报错，
 * 只是读到空库。搬家会再发生，所以路径只从这里取。
 *
 * 三个口子：
 *   home()       DSH 的家目录（DSH_HOME 优先，其次当前用户 ~/.dsh）
 *   dbPath()     线上库（DSH_DB 优先，其次 home()/consciousness/app.db）
 *   repoRoot()   本仓库根目录（按这个文件自己的位置算，跟搬去哪无关）
 *   picturesDir() / stickersDir()  用户图片与贴纸目录（贴纸可用 PAINT_REF_DIR 覆盖）
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** DSH 家目录：环境变量优先，其次当前用户的 ~/.dsh */
export function home() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? env.trim() : path.join(os.homedir(), '.dsh')
}

/** 线上库的路径：DSH_DB 优先，其次 home()/consciousness/app.db */
export function dbPath() {
  const env = process.env.DSH_DB
  if (env && env.trim()) return env.trim()
  return path.join(home(), 'consciousness', 'app.db')
}

/** 本仓库根目录（src/paths.js 的上一级） */
export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** 用户图片目录 */
export function picturesDir() {
  return path.join(os.homedir(), 'Pictures')
}

/** 贴纸参考图目录：PAINT_REF_DIR 优先，其次 ~/Pictures/dsh-stickers */
export function stickersDir() {
  const env = process.env.PAINT_REF_DIR
  return env && env.trim() ? env.trim() : path.join(picturesDir(), 'dsh-stickers')
}
