import fs from 'node:fs'
import path from 'node:path'
const root = process.cwd()
const files = []
function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); if(e.isDirectory()){ if(e.name==='node_modules')continue; walk(p)} else if(/\.(js|mjs)$/.test(e.name)) files.push(p) } }
walk(path.join(root,'src')); files.push(path.join(root,'index.js'), path.join(root,'client.js'))
const text = new Map()
for(const f of files) text.set(f, fs.readFileSync(f,'utf8'))
const refs = new Map()
function add(target, from){ if(!refs.has(target)) refs.set(target,new Set()); refs.get(target).add(from) }
for(const [f,t] of text){
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  let m
  while((m=re.exec(t))){
    const spec = m[1]
    let resolved = null
    if(spec.startsWith('.')){
      let base = path.resolve(path.dirname(f), spec)
      for(const c of [base, base+'.js', base+'.mjs', path.join(base,'index.js')]){ if(fs.existsSync(c) && fs.statSync(c).isFile()){ resolved=c; break } }
      if(!resolved) resolved='MISSING:'+spec
    } else resolved='EXT:'+spec
    add(resolved, f)
  }
}
const srcFiles = [...text.keys()].filter(f=>f.startsWith(path.join(root,'src')))
const rows = srcFiles.map(f=>{ const r=refs.get(f)||new Set(); return {f:path.relative(root,f), n:r.size, from:[...r].map(x=>path.relative(root,x)).slice(0,6).join(' | ')} })
rows.sort((a,b)=>a.n-b.n)
for(const r of rows.filter(r=>r.n<=1)) console.log(String(r.n).padStart(2), r.f, r.n?('<- '+r.from):'')
console.log('--- EXT unresolved ---')
for(const [k,v] of refs) if(k.startsWith('EXT:')||k.startsWith('MISSING:')) console.log(k, '<-', [...v].map(x=>path.relative(root,x)).join(' , '))
