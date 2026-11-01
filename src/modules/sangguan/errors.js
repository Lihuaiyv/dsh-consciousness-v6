/** 三观引擎错误：INVALID 形状不对；TRANSITION 状态迁移非法；INVARIANT 不变式被破坏；ConflictError 为 expect 不符 / 幂等键重复。 */
export class SangguanError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}
export class ConflictError extends SangguanError {}
