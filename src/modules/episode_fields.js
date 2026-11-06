/**
 * 纪要的窄写口（episodes 归「归档」管）。
 *
 * 为什么单独一个文件：归档要 import 日记的成文逻辑（buildDiaryV2），
 * 日记又要把「这段的戳心度」写回 episodes——两边直接 import 会成环。
 * 把这一条 UPDATE 放在这里：日记只调它，归档的 files 名单里有它，
 * 表就还是只有一个写手，依赖也不成环。
 */

/** 只写一段纪要的「戳心度」；别的列一概不碰。 */
export function setEpisodePoignancy(db, aid, id, score) {
  db.prepare('UPDATE episodes SET poignancy=? WHERE id=? AND agent_id=?')
    .run(Number(score) || 0, id, aid)
}
