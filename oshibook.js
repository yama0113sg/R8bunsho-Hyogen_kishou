/* 推し短編集を「本」としてページをめくって読む画面（アプリとクラス文庫の両方で使う）
   OshiBook.open({title, editor, theme, cover, intro, after, items:[{title, pen, genreName, text, obi:{catch, body, pen}|null, review}]})
   ページは縦書き。左へめくると次のページ（日本の本と同じ向き）。 */
(function(){
const CSS=`
.obk{position:fixed;inset:0;z-index:200;background:rgba(6,5,12,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:max(10px,env(safe-area-inset-top)) 10px max(10px,env(safe-area-inset-bottom));touch-action:pan-y;user-select:none;-webkit-user-select:none}
.obk *{box-sizing:border-box}
.obk-top{width:100%;max-width:640px;display:flex;justify-content:space-between;align-items:center;color:#cfcbe6;font-size:13px;margin-bottom:8px;gap:8px}
.obk-top b{font-family:"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho",serif;font-size:15px;color:#fff;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.obk button{font:inherit;cursor:pointer;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;border-radius:12px;padding:8px 14px}
.obk button:disabled{opacity:.25;cursor:default}
.obk-stage{position:relative}
.obk-page{position:relative;background:#fbfaf7;color:#222;border-radius:4px 10px 10px 4px;box-shadow:0 20px 50px rgba(0,0,0,.6),inset -10px 0 18px rgba(0,0,0,.06);
  overflow:hidden;font-family:"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho",serif}
.obk-page.turn{animation:obkT .28s ease-out}
.obk-page.turnb{animation:obkB .28s ease-out}
@keyframes obkT{from{opacity:.2;transform:translateX(-26px)}}
@keyframes obkB{from{opacity:.2;transform:translateX(26px)}}
.obk-body{position:absolute;inset:7% 8% 9%;writing-mode:vertical-rl;overflow:hidden;font-size:var(--fs);line-height:1.9;white-space:pre-wrap;word-break:break-all;line-break:strict;text-align:justify}
.obk-body h2{font-size:1.35em;margin:0 0 0 1.4em;font-weight:800;letter-spacing:.1em}
.obk-body .sig{display:block;text-align:end;margin-right:1em}
.obk-no{position:absolute;bottom:3%;left:0;right:0;text-align:center;font-size:11px;color:#999;font-family:sans-serif}
.obk-run{position:absolute;top:2.6%;left:8%;font-size:10px;color:#aaa;letter-spacing:.1em}
.obk-nav{display:flex;gap:12px;margin-top:10px;align-items:center;color:#cfcbe6;font-size:13px}
.obk-toc{display:block}
.obk-toc .tl{display:block;margin-left:.5em}
.obk-toc .tl small{font-size:.8em;color:#666;margin-top:1em}
/* 表紙 */
.obk-cv{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:14%;container-type:inline-size}
.obk-cv .ot{font-weight:800;font-size:clamp(20px,11cqw,44px);line-height:1.4;letter-spacing:.06em}
.obk-cv .oth{font-size:clamp(11px,5cqw,18px);margin-top:5cqw;opacity:.85}
.obk-cv .oe{position:absolute;bottom:10cqw;left:0;right:0;font-size:clamp(11px,4.6cqw,16px);letter-spacing:.15em;opacity:.9}
.obk-cv .ol{position:absolute;top:8cqw;left:0;right:0;font-size:clamp(9px,3.4cqw,12px);letter-spacing:.3em;opacity:.7}
.obk-cv.c0{background:radial-gradient(circle at 70% 20%,#3b3570 0,#15112a 60%);color:#f3eccf}
.obk-cv.c0::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(1px 1px at 20% 30%,#fff,transparent),radial-gradient(1.5px 1.5px at 80% 60%,#fff,transparent),radial-gradient(1px 1px at 45% 15%,#fff,transparent),radial-gradient(1px 1px at 65% 85%,#fff,transparent);opacity:.7}
.obk-cv.c1{background:linear-gradient(160deg,#fde6ee,#f2b8cb);color:#5a2236}
.obk-cv.c2{background:linear-gradient(160deg,#f4efe4,#ddd3bf);color:#2a2620}
.obk-cv.c2::before{content:"";position:absolute;inset:6cqw;border:1px solid rgba(42,38,32,.35)}
.obk-cv.c3{background:linear-gradient(170deg,#9fd9ef,#2f6f9a);color:#fff}
/* 作品の扉（帯つき） */
.obk-door{position:absolute;inset:0;display:flex;flex-direction:column}
.obk-door .dt{flex:1;min-height:0;writing-mode:vertical-rl;padding:14% 12% 6%;overflow:hidden}
.obk-door .dt span{display:block}
.obk-door .dn{font-size:calc(var(--fs)*1.2);color:#999;margin-left:1em}
.obk-door .dh{font-size:calc(var(--fs)*1.8);font-weight:800;letter-spacing:.12em;margin-left:1em;line-height:1.4}
.obk-door .dp{font-size:var(--fs);color:#555;padding-top:3em}
.obk-obi{background:#f7f3ea;border-top:3px solid #c9a24a;padding:5% 8% 7%;text-align:center}
.obk-obi .oc{font-weight:800;font-size:calc(var(--fs)*1.15);line-height:1.5}
.obk-obi .ob{font-size:calc(var(--fs)*.78);line-height:1.7;margin-top:.5em;color:#444;text-align:left}
.obk-obi .op{font-size:calc(var(--fs)*.7);color:#777;margin-top:.4em;text-align:right}
.obk-end{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:12%;font-size:calc(var(--fs)*.85);line-height:1.9;color:#333}
.obk-end h3{font-size:1.2em;margin:0 0 .6em;border-bottom:1px solid #ccc;padding-bottom:.4em}
.obk-end .ft{margin-top:1.4em;font-size:.85em;color:#888}
.obk-todo{position:absolute;inset:10%;border:2px dashed #c9c2b0;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1em;text-align:center;color:#8a8170;font-size:calc(var(--fs)*.95);line-height:1.8}
.obk-todo .th{font-weight:800;font-size:1.25em;color:#555}
.obk .obk-todo-go{background:#2a2333;color:#fff;border:none;border-radius:12px;padding:10px 18px;font-size:15px}
.obk-cv .odr{position:absolute;top:16cqw;left:0;right:0;font-size:clamp(9px,3.4cqw,12px);letter-spacing:.15em;opacity:.85}
.obk-hint{font-size:12px;color:#8f8aa8;margin-top:6px}
`;
const KAN=["一","二","三","四","五","六","七","八","九","十","十一","十二"];
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let root=null, pages=[], at=0, book=null, size=null;

function pageSize(){ const H=Math.min(window.innerHeight-130, 900), W=Math.min(window.innerWidth-20, 620);
  let h=H, w=Math.round(h*0.7); if(w>W){ w=W; h=Math.round(w/0.7); }
  return {w,h,fs:Math.max(14,Math.min(19,Math.round(w/26)))}; }

// 本文を、ページにおさまるだけずつ切り分ける（実際に組んでみて測る）
function paginate(meas, text, head, sig){
  const out=[]; let rest=String(text||"").replace(/\r/g,""), first=true;
  const body=meas.querySelector(".obk-body");
  const fits=html=>{ body.innerHTML=html; return body.scrollWidth<=body.clientWidth+1; };
  const html=(t,isFirst,withSig)=>(isFirst&&head?"<h2>"+esc(head)+"</h2>":"")+esc(t)+(withSig&&sig?'<span class="sig">'+esc(sig)+"</span>":"");
  while(true){
    if(fits(html(rest,first,true))){ out.push(html(rest,first,true)); break; }
    const ch=[...rest]; let lo=1, hi=ch.length;
    while(lo<hi){ const mid=Math.ceil((lo+hi)/2); if(fits(html(ch.slice(0,mid).join(""),first,false))) lo=mid; else hi=mid-1; }
    let n=lo; const nl=ch.slice(0,n).lastIndexOf("\n"); if(nl>n*0.75) n=nl+1;   // きりのいい改行で切る
    out.push(html(ch.slice(0,n).join(""),first,false)); rest=ch.slice(n).join("").replace(/^\n+/,""); first=false;
    if(!rest){ if(sig) out.push(html("",false,true)); break; }
    if(out.length>400) break;
  }
  return out.map(h=>({kind:"text",html:h}));
}
function build(){
  size=pageSize();
  const meas=document.createElement("div"); meas.className="obk-page"; meas.style.cssText="position:fixed;left:-9999px;top:0;visibility:hidden;width:"+size.w+"px;height:"+size.h+"px;--fs:"+size.fs+"px";
  meas.innerHTML='<div class="obk-body"></div>'; document.body.appendChild(meas);
  const b=book, P=[];
  P.push({kind:"cover"});
  // b.draft のとき（編集中のプレビュー）は、まだ書いていないところに「まだです」のページをはさむ
  const todo=(head,k)=>({kind:"todo",head,k});
  if(b.intro) P.push(...paginate(meas,b.intro,"はじめに","編者　"+(b.editor||"")).map(p=>({...p,run:"はじめに"})));
  else if(b.draft) P.push(todo("はじめに","intro"));
  P.push({kind:"toc"});
  b.items.forEach((it,i)=>{
    P.push({kind:"door",i});
    P.push(...paginate(meas,it.text||"（この作品は、いま読めません）","","").map(p=>({...p,run:KAN[i]+"　"+it.title})));
    if(it.review) P.push(...paginate(meas,it.review,"書評　『"+it.title+"』","評・"+(b.editor||"")).map(p=>({...p,run:"書評"})));
    else if(b.draft) P.push(todo("書評　『"+it.title+"』","rv"+i));
  });
  if(b.after) P.push(...paginate(meas,b.after,"あとがき","編者　"+(b.editor||"")).map(p=>({...p,run:"あとがき"})));
  else if(b.draft) P.push(todo("あとがき","after"));
  P.push({kind:"end"});
  meas.remove(); pages=P;
}
function pageHTML(p){
  const b=book;
  if(p.kind==="cover") return '<div class="obk-cv c'+(b.cover||0)+'"><div class="ol">推 し 短 編 集</div>'+(b.draft?'<div class="odr">編集中のプレビュー</div>':'')+'<div class="ot">'+esc(b.title)+'</div>'+(b.theme?'<div class="oth">'+esc(b.theme)+'</div>':'')+'<div class="oe">編・'+esc(b.editor)+'</div></div>';
  if(p.kind==="todo") return '<div class="obk-todo"><div class="th">'+esc(p.head)+'</div><div class="tm">ここに入る文章は、<br>まだ書かれていません。</div>'
    +(b.onTodo?'<button class="obk-todo-go" data-k="'+esc(p.k)+'">✎ ここを書きに行く</button>':'')+'</div>';
  if(p.kind==="toc") return '<div class="obk-body obk-toc"><h2>目次</h2>'+b.items.map((it,i)=>'<span class="tl">'+KAN[i]+'　『'+esc(it.title)+'』　<small>'+esc(it.pen||"")+'</small></span>').join("")+'</div>';
  if(p.kind==="door"){ const it=b.items[p.i], o=it.obi;
    return '<div class="obk-door"><div class="dt"><span class="dn">'+KAN[p.i]+'</span><span class="dh">'+esc(it.title)+'</span><span class="dp">'+esc(it.pen||"")+(it.genreName?'　〈'+esc(it.genreName)+'〉':'')+'</span></div>'
      +(o?'<div class="obk-obi"><div class="oc">'+esc(o.catch)+'</div><div class="ob">'+esc(o.body)+'</div><div class="op">推薦・'+esc(o.pen)+'</div></div>':'')+'</div>'; }
  if(p.kind==="end") return '<div class="obk-end"><h3>『'+esc(b.title)+'』</h3><div>編者　'+esc(b.editor)+'</div>'+(b.theme?'<div>テーマ　'+esc(b.theme)+'</div>':'')
    +'<div style="margin-top:.8em">収録作品</div>'+b.items.map((it,i)=>'<div>'+KAN[i]+'　『'+esc(it.title)+'』　'+esc(it.pen||"")+'</div>').join("")
    +'<div class="ft">クラス文庫　推し短編集</div></div>';
  return (p.run?'<div class="obk-run">'+esc(p.run)+'</div>':'')+'<div class="obk-body">'+p.html+'</div>';
}
function show(dir){
  const pg=root.querySelector(".obk-page");
  pg.style.width=size.w+"px"; pg.style.height=size.h+"px"; pg.style.setProperty("--fs",size.fs+"px");
  pg.innerHTML=pageHTML(pages[at])+(at>0&&at<pages.length-1?'<div class="obk-no">'+at+'</div>':'');
  pg.classList.remove("turn","turnb"); void pg.offsetWidth; if(dir) pg.classList.add(dir>0?"turn":"turnb");
  root.querySelector(".obk-pos").textContent=(at+1)+" / "+pages.length;
  root.querySelector(".obk-next").disabled=at>=pages.length-1; root.querySelector(".obk-prev").disabled=at<=0;
}
const move=d=>{ const n=Math.max(0,Math.min(pages.length-1,at+d)); if(n!==at){ at=n; show(d); } };
function onKey(e){ if(!root) return; if(e.key==="ArrowLeft") move(1); else if(e.key==="ArrowRight") move(-1); else if(e.key==="Escape") close(); }
let rsT=0;
function onResize(){ if(!root) return; clearTimeout(rsT); rsT=setTimeout(()=>{ const f=at/Math.max(1,pages.length-1); build(); at=Math.round(f*(pages.length-1)); show(0); },250); }
function close(){ if(!root) return; root.remove(); root=null; document.removeEventListener("keydown",onKey); window.removeEventListener("resize",onResize); document.body.style.overflow=""; }
async function open(b){
  if(!document.getElementById("obkCss")){ const s=document.createElement("style"); s.id="obkCss"; s.textContent=CSS; document.head.appendChild(s); }
  close(); book=b; at=0;
  root=document.createElement("div"); root.className="obk";
  root.innerHTML='<div class="obk-top"><b>『'+esc(b.title)+'』</b><button class="obk-x">とじる ✕</button></div>'
    +'<div class="obk-stage"><div class="obk-page"></div></div>'
    +'<div class="obk-nav"><button class="obk-next">‹ つぎへ</button><span class="obk-pos"></span><button class="obk-prev">まえへ ›</button></div>'
    +'<div class="obk-hint">ページの左はしをタップ／右へスワイプで、つぎのページ</div>';
  document.body.appendChild(root); document.body.style.overflow="hidden";
  try{ if(document.fonts&&document.fonts.ready) await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1500))]); }catch(e){}
  build(); show(0);
  root.querySelector(".obk-x").onclick=close;
  root.querySelector(".obk-next").onclick=()=>move(1);
  root.querySelector(".obk-prev").onclick=()=>move(-1);
  const pg=root.querySelector(".obk-page");
  pg.addEventListener("click",e=>{ const go=e.target.closest(".obk-todo-go"); if(go){ const k=go.dataset.k, f=b.onTodo; close(); if(f) f(k); return; }
    const r=pg.getBoundingClientRect(), x=(e.clientX-r.left)/r.width; if(x<.38) move(1); else if(x>.62) move(-1); });
  let sx=null, sy=0;
  pg.addEventListener("touchstart",e=>{ sx=e.touches[0].clientX; sy=e.touches[0].clientY; },{passive:true});
  pg.addEventListener("touchend",e=>{ if(sx==null) return; const dx=e.changedTouches[0].clientX-sx, dy=e.changedTouches[0].clientY-sy; sx=null;
    if(Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)){ e.preventDefault(); move(dx>0?1:-1); } });
  document.addEventListener("keydown",onKey); window.addEventListener("resize",onResize);
}
window.OshiBook={open,close};
})();
