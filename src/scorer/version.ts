/**
 * 判分器的身份。
 *
 * 为什么两者都要：
 *   - version 是**人有意声明**的 —— 判定规则改了就得手动 bump，它表达"我知道我改了判据"
 *   - sha256 是**自动**的 —— 忘了 bump 也能查出来，重打分时靠它对账
 *
 * 没有它，改一次判据就会让老分数静默过期：同一份 run 前后能判出不同结果，
 * 而 run.json 里没有任何字段能指出这件事。
 */

/** 判定逻辑的语义版本；**改判定规则时必须 +1** */
export const SCORER_VERSION = 1

/** 判定逻辑由这几个文件构成（相对仓库根，路径进哈希清单，所以必须是相对路径） */
export const SCORER_SOURCES = ['src/scorer/main.ts', 'src/runner/task.ts']
