const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.USERPROFILE + '\\.dsh\\consciousness\\app.db', { readOnly: true });
const aid='agt_3977d80f17';
// 复刻 passport.topicOfFactKey 的近似：取 fact_key 中间段最长者
const EXCLUDE=new Set(['用户','助手','我','你','他','她','主人','小汐','对方','自己']);
const STATE=new Set(['待完成','完成','已完成','已','未','进行中','待办','已做','没做','还没做']);
const topic=(fk)=>{const p=String(fk||'').split('.').map(s=>s.trim()).filter(Boolean); if(p.length<2) return ''; const mid=p.slice(1,p.length>2?-1:undefined).filter(s=>s.length>=2&&!EXCLUDE.has(s)&&!STATE.has(s)); mid.sort((a,b)=>b.length-a.length); return mid[0]||'';};
const rows=db.prepare("SELECT id,text,fact_key,created_at,invalid_at FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND fact_key IS NOT NULL AND fact_key<>''").all(aid);
const later=db.prepare("SELECT 1 FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND id<>? AND fact_key LIKE ? AND created_at>? LIMIT 1");
let stale=0, topics=new Set(), miss=0;
for(const r of rows){ const t=topic(r.fact_key); if(!t){miss++;continue;} topics.add(t); if(later.get(aid,r.id,'%'+t+'%',r.created_at)) stale++; }
console.log(JSON.stringify({activeWithKey:rows.length, staleCandidates:stale, distinctTopics:topics.size, noTopic:miss}));
// 同一 topic 出现多条的分布
const byTopic={}; for(const r of rows){ const t=topic(r.fact_key); if(t) byTopic[t]=(byTopic[t]||0)+1; }
console.log('top duplicated topics', Object.entries(byTopic).sort((a,b)=>b[1]-a[1]).slice(0,8));
