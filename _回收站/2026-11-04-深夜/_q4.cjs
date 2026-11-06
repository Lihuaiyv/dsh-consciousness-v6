const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.USERPROFILE + '\\.dsh\\consciousness\\app.db', { readOnly: true });
const aid='agt_3977d80f17';
const R=db.prepare("SELECT id,fact_key,created_at FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND fact_key IS NOT NULL AND fact_key<>''").all(aid);
const EX=new Set(['用户','助手','我','你','他','她','主人','小汐','对方','自己']);
const ST=new Set(['待完成','完成','已完成','已','未','进行中','待办','已做','没做','还没做']);
const topic=(fk)=>{const p=String(fk||'').split('.').map(s=>s.trim()).filter(Boolean); if(p.length<2) return ''; const m=p.slice(1,p.length>2?-1:undefined).filter(s=>s.length>=2&&!EX.has(s)&&!ST.has(s)); m.sort((a,b)=>b.length-a.length); return m[0]||'';};
const g=new Map(); for(const r of R){const t=topic(r.fact_key); if(!t)continue; (g.get(t)||g.set(t,[]).get(t)).push(r);}
let n30=0, any=0;
for(const [t,l] of g){ l.sort((a,b)=>a.created_at<b.created_at?-1:1); for(let i=0;i<l.length-1;i++){ any++; const n=l.slice(i+1).find(x=>Date.parse(x.created_at)-Date.parse(l[i].created_at)>=30*60000); if(n) n30++; } }
console.log(JSON.stringify({anyLater:any, with30min:n30}));
