// ============================================================
//  起承転結 用 中継 Worker（worker_kishou.js）
//  いま動いている tsukutte の Worker とは別物です。
//  GitHub の main とつないであり（Cloudflare Workers Builds・Path /worker）、push すると自動でデプロイされる。
//  変数：GEMINI_API_KEY（Secret）／ALLOWED_ORIGIN = https://yama0113sg.github.io
//  POST {stage, genre, story, avoid}            → {line}   一行を引く
//  POST {mode:"hint", stage, genre, story, line, body, avoid} → {hints:[問い,問い]}
//  POST {mode:"bridge", stage, genre, before, line, after}    → {bridge}   整えるときのつなぎの文
//
//  ── クラス文庫（/bunko/...）──
//  KV：BUNKO（KV namespace のバインディング）
//  Secret：CLASS_PASS（生徒の合言葉）／TEACHER_PASS（先生用の合言葉）
//  作品も感想も、先生が［公開］するまでは他の人に見えない
//  AIの感想：先生が作品を公開すると、3人の「AIの読み手」（シオリ・ハグルマ・ソラ）の感想を作り、時間をずらして見せる
// ============================================================

const MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
];
// ヒントは lite だけで回す（lite でない Flash は1日20回しかないため）
const HINT_MODELS = MODELS.slice(0, 2);

const GENRES = {
  nichijo: "日常（なにげない学校生活や街の出来事）",
  seishun: "青春（友情・部活・進路・ちょっとした恋心）",
  renai: "恋愛（片想い、すれちがい、言えない気持ち。高校生らしい淡い恋の空気まで。体のふれあいや性的な場面は出さない）",
  mystery: "ミステリー（小さな謎、消えたもの、隠された理由）",
  sf: "SF（少しだけ不思議な技術や、ありえない現象）",
  fantasy: "ファンタジー（現実に少しだけ魔法が混ざる）",
  comedy: "コメディ（勘違い、ドタバタ、くだらなくて笑える）",
  kowai: "ちょっと怖い（不気味だけど、どこか軽やかで後味は悪くない）",
};

const BASE = `あなたは高校3年生の創作の授業で、物語の「きっかけ」だけを出す係です。
文章を書くのは生徒です。あなたは一文だけを出します。
守ること：
・出力は日本語の一文だけ。前置き、説明、かぎかっこ、記号、番号、改行は付けない。
・60字以内。
・暴力の詳しい描写、性的な内容、自傷、差別、実在の人物・作品・商品名は出さない。
・家庭の事情（親の離婚・病気・貧困など）には触れない。
・生徒がすぐに続きを書きたくなる、具体的で、少し意外な一文にする。`;

const STAGE_RULE = {
  ki: `いまは「起」です。物語の最初の一文（書き出し）を書いてください。
登場人物や場所がすぐ思い浮かび、「この先どうなるの？」と思わせる一文にします。`,
  sho: `いまは「承」です。生徒が書いた「起」を読み、その流れを受けて次に起こる出来事を一文で示してください。
物語の地の文ではなく、「〜が〜する」という出来事の要約として書きます。流れは大きく変えず、話を深める方向にします。`,
  ten: `いまは「転」です。それまでの物語を読み、流れをひっくり返す意外な出来事を一文で示してください。
「〜が〜する」という出来事の要約として書きます。それまでに出てきた人物や物を使って、予想を裏切ってください。`,
  ketsu: `いまは「結」です。それまでの物語を読み、どう締めくくるかの方向を一文で示してください。
「〜が〜する」という出来事の要約として書きます。全部を説明しきらず、余韻が残る方向にします。`,
};

const HINT_BASE = `あなたは高校3年生の創作の授業で、書く手が止まった生徒に「問いかけ」をする係です。
文章を書くのは生徒です。あなたは物語の文章を一切書きません。
守ること：
・生徒が続きを考えるきっかけになる問いを、2つ出す。
・一つの問いを一行に書き、全部で2行にする。前置き、番号、記号、説明は付けない。
・どちらも「？」で終わる疑問文にする。30字以内。
・問いの中に、物語の文や台詞（かぎかっこ）を書かない。「〜と書くとよい」のような指示や、答えの例も書かない。
・生徒の文章をほめたり、評価したりしない。
・生徒の文章にすでに書いてあることは聞かない。まだ書かれていない、人物の気持ち・見えるもの・聞こえるもの・行動・理由などを聞く。
・暴力の詳しい描写、性的な内容、自傷、差別、実在の人物・作品・商品名、家庭の事情には触れない。`;

const HINT_STAGE = {
  ki: "いまは「起」です。主人公がだれか、いつ・どこの話か、引いた一文を主人公がどう受けとめたかが見えてくる問いにします。謎の答えや結末は聞きません。",
  sho: "いまは「承」です。起で始まったことがふくらむ問いにします。人物の気持ちや、ほかの人物との関係を聞きます。大事件を起こす方向には誘いません。",
  ten: "いまは「転」です。引いた出来事を目の前の場面として書けるよう、主人公の驚き、行動、それまでの見え方の変化を聞きます。夢オチやうそオチには誘いません。",
  ketsu: "いまは「結」です。そのあと主人公がどうなったか、起と比べて何が変わったか、最後の場面を聞きます。新しい人物や新しい謎は出しません。",
};

function cors(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || "";
  return {
    "Access-Control-Allow-Origin": origin === allowed ? allowed : "null",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Pass, X-Teacher",
    "Content-Type": "application/json; charset=utf-8",
  };
}

const BRIDGE_BASE = `あなたは高校3年生の創作の授業で、生徒が書いた短い物語の「つなぎ目」をなめらかにする係です。
物語は場面ごとに書かれていて、場面と場面のあいだに、その場面で起きることが書かれていません。
前の場面の終わりと次の場面の書き出しのあいだに入れる、短いつなぎの文を書いてください。
生徒はこのあと、あなたの文を自分の言葉に書き直します。
守ること：
・出力はつなぎの文だけ。前置き、説明、記号、番号、改行は付けない。
・1〜2文、80字以内。
・「次の場面で起きること」を、前の場面の終わりから自然に続くように書き、次の場面の書き出しにそのままつながるようにする。
・生徒の文体（一人称、「だ・である」か「です・ます」か、語り口）に合わせる。
・前後の文をくり返さない。次の場面の書き出しにすでに書いてあることは書かない。
・新しい人物や設定を足さない。
・暴力の詳しい描写、性的な内容、自傷、差別、実在の人物・作品・商品名、家庭の事情には触れない。`;

// ── AIの感想（クラス文庫）：3人の「AIの読み手」──
// 読み方のちがう3人が、短く、くだけた言葉で感想を返す。人のふりはしない（画面では「AI」の印が付く）。
// 公開してすぐ付くと不自然なので、1人目・2人目・3人目を時間をずらして見せる（分。秒までランダム）。
const AI_SLOTS = [[7, 14], [20, 40], [50, 90]];
// 文体を変えたら AI_STYLE を上げる。一括のボタンで、古い文体の感想が作り直される
const AI_STYLE = 2;
const AI_READERS = [
  { key: "shiori", name: "シオリ",
    desc: "ことば派。気に入った一文や言葉だけを、ぽつっと言う。短い。説明しない。体言止めや言いさしが多い。ほめ言葉をあまり使わない。",
    ex: ["「まだ少し温かい」のとこ、ずっと残ってる。", "鍵の言い方、ちょっと笑った。", "最後の一文、声に出して読んだ。"] },
  { key: "haguruma", name: "ハグルマ",
    desc: "考察派。ひとりでぶつぶつ考えている。気づいたことや疑問をそのまま言う。決めつけずに「〜かな」「〜では」で終わることが多い。話の仕組みや、前の場面とのつながりが気になる。",
    ex: ["フクロウ、最初の場面からいたよね。読み返したらいた。", "鍵の持ち主、結局だれなんだろう。先生では？", "転で一回ひっくり返ったのに、結で静かに戻るのがいい。"] },
  { key: "sora", name: "ソラ",
    desc: "気持ち派。読んでいて思ったことがそのまま口に出る。語彙が少なくて、テンションで話す。登場人物に話しかけることもある。",
    ex: ["え、まって、ここで終わるの", "主人公、それは言っちゃだめだって笑", "屋上のとこ、なんか泣きそうになった"] },
];
const AI_COMMENT_BASE = `高校3年生のクラスで、生徒が書いた短い物語をみんなで読み合っています。
あなたはそこに混ざっている3人の「AIの読み手」として、読んだあとのひとことを書きます。
国語の先生や本の評論家のような感想ではなく、同じ教室の高校生が感想欄にさっと書くひとことにしてください。

3人：
${AI_READERS.map(r => `・${r.key}（${r.name}）：${r.desc}\n　書きぶりの例：${r.ex.map(x => "「" + x + "」").join("")}`).join("\n")}

守ること：
・書きぶりの例は、口調をつかむためだけのもの。例の言い回しをそのまま使わず、この作品に合わせて言う。
・それぞれ10〜60字。長くしない。3人の長さもばらばらにする。
・きちんとした文にまとめなくてよい。言いさし、体言止め、話し言葉のままでよい。
・「よかったところ＋気になったところ」のような、整った型にしない。思ったことを一つだけ言う。
・3人で、同じ場面・同じ一文に触れない。言い回しや語尾もかぶらせない。
・作品に出てくる具体的なもの（人物、物、場面、一文）を一つは入れる。ただし、あらすじの説明はしない。
・ほめる言葉、点数、助言、まとめ、お説教は書かない。
・次の言葉は使わない：素晴らしい、見事、印象的、心温まる、感動、光って、作者、描写、表現、世界観、心情、引き込まれ、伝わって、余韻、絶妙、巧み、秀逸、共感、ですね、ました。
・改行、絵文字、見出しは付けない。「！」は使わない。
・暴力の詳しい描写、性的な内容、自傷、差別、実在の人物・作品・商品名、家庭の事情には触れない。作品がこれらに触れていても、感想では掘り下げない。
出力は次の形の JSON だけ：{"shiori":"…","haguruma":"…","sora":"…"}`;
const AI_NG = /素晴らし|見事|印象的|心温ま|感動|光って|作者|描写|世界観|心情|引き込ま|伝わって|余韻|絶妙|巧み|秀逸|共感/;

function parseAiComments(t) {
  if (!t) return null;
  let o;
  try { o = JSON.parse(t.replace(/^\s*```(json)?/i, "").replace(/```\s*$/, "").trim()); } catch { return null; }
  const out = {};
  for (const r of AI_READERS) {
    let s = String((o && o[r.key]) || "").replace(/\*\*/g, "").replace(/\s*\n\s*/g, "").trim();
    s = s.replace(new RegExp("^(" + r.name + "|" + r.key + ")[：:]\\s*"), "");
    s = s.replace(/！/g, "");
    const n = [...s].length;
    if (n < 6 || n > 90 || AI_NG.test(s)) return null;   // 長すぎ・AIっぽい言葉は、次のモデルで作り直す
    out[r.key] = s;
  }
  return out;
}

// 作品のAIの感想を、すべて消す（前の「AIの読み手」1人版もふくむ）
async function deleteAiComments(kv, id) {
  for (const k of await listAll(kv, "c:" + id + ":ai")) await kv.delete(k.name);
}
// いまの版への3人の感想が、もうあるか（1人版の「AIの読み手」だけなら、3人版に置きかえる）
async function hasAiComments(kv, w) {
  for (const k of await listAll(kv, "c:" + w.id + ":ai-")) {
    const c = await kv.get(k.name, { type: "json" });
    if (c && c.persona && c.forUpdated === w.updated && c.style === AI_STYLE) return true;
  }
  return false;
}
// 3人の感想を1回の問い合わせでまとめて作り、時間をずらして保存する。できたら true
async function makeAiComment(env, w) {
  const text = clip(w.text, 6000);
  const g = GENRES[w.genre] ? GENRES[w.genre].split("（")[0] : "";
  const user = `タイトル：『${w.title}』\nジャンル：${g}\n\n本文：\n${text}\n\n3人の感想を JSON で出してください。`;
  let result;
  try { ({ result } = await callGemini(env, AI_COMMENT_BASE, user, { models: HINT_MODELS, parse: parseAiComments, temperature: 1.0, json: true })); }
  catch { return false; }
  // もう届いていた感想は、作り直しても同じ時刻に届いた扱いにする（消えてから出直さないように）
  const old = {};
  for (const k of await listAll(env.BUNKO, "c:" + w.id + ":ai-")) {
    const c = await env.BUNKO.get(k.name, { type: "json" });
    if (c && c.persona && c.forUpdated === w.updated) old[c.persona] = c.showAt;
  }
  await deleteAiComments(env.BUNKO, w.id);
  const now = Date.now();
  const order = AI_READERS.slice().sort(() => Math.random() - 0.5);   // だれが先に届くかも毎回ちがう
  for (let i = 0; i < order.length; i++) {
    const r = order[i], [lo, hi] = AI_SLOTS[i] || AI_SLOTS[AI_SLOTS.length - 1];
    const showAt = old[r.key] || now + Math.round((lo + Math.random() * (hi - lo)) * 60000);
    const c = { id: "ai-" + r.key, workId: w.id, name: r.name, persona: r.key, text: result[r.key], ai: true, status: "public", showAt, created: now, forUpdated: w.updated, style: AI_STYLE };
    await env.BUNKO.put("c:" + w.id + ":ai-" + r.key, JSON.stringify(c), { metadata: { status: "public", ai: true, showAt } });
  }
  return true;
}

function parseBridge(t) {
  if (!t) return "";
  let s = t.replace(/\*\*/g, "").split("\n").map(x => x.trim()).filter(Boolean).join("");
  s = s.replace(/^(つなぎ(の文)?[：:])/, "").replace(/[〔〕]/g, "").trim();
  if (/^「[^「」]*」$/.test(s) === false) s = s.replace(/^[『"“]+|[』"”]+$/g, "");
  const n = [...s].length;
  return n >= 5 && n <= 120 ? s : "";
}

function cleanLine(t) {
  if (!t) return "";
  let line = t.split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
  line = line.replace(/^[-*・>#\d.\s]+/, "").replace(/\*\*/g, "");
  line = line.replace(/^[「『"“]+|[」』"”]+$/g, "").trim();
  return line.slice(0, 90);
}

// 問いの形になっていないもの（文章・台詞・長すぎるもの）は捨てる
function parseHints(t) {
  if (!t) return null;
  const out = t.split("\n")
    .map(s => s.trim().replace(/^[-*・>#\d.)）\s]+/, "").replace(/\*\*/g, "").trim())
    .filter(s => s && /[？?]$/.test(s) && [...s].length <= 40 && !/[「」『』"“”]/.test(s))
    .slice(0, 2);
  return out.length ? out : null;
}

async function callGemini(env, system, user, { models = MODELS, parse = cleanLine, temperature = 1.1, json = false } = {}) {
  let lastErr = "";
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: Object.assign({ temperature, maxOutputTokens: 1024 }, json ? { responseMimeType: "application/json" } : {}),
      }),
    });
    if (!res.ok) { lastErr = `${model}:${res.status}`; continue; }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    const result = parse(text);
    if (result && (typeof result !== "string" || result.length)) return { result, model };
    lastErr = `${model}:empty`;
  }
  throw new Error(lastErr || "no model");
}

// ============ クラス文庫 ============
const J = (obj, headers, status = 200) => new Response(JSON.stringify(obj), { status, headers });
const clip = (s, n) => String(s || "").slice(0, n);
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function listAll(kv, prefix) {
  const out = []; let cursor;
  do { const r = await kv.list({ prefix, cursor }); out.push(...r.keys); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}
const workMeta = w => ({ id: w.id, pen: w.pen, title: w.title, genre: w.genre, status: w.status,
  chars: [...w.text.replace(/\s/g, "")].length, created: w.created, updated: w.updated });
const withoutOwner = w => { const { owner, ...rest } = w; return rest; };
async function deleteWork(kv, id) {
  await kv.delete("w:" + id);
  for (const k of await listAll(kv, "c:" + id + ":")) await kv.delete(k.name);
}

async function bunko(request, env, headers, path, ctx) {
  const later = p => (ctx && ctx.waitUntil) ? ctx.waitUntil(p) : p;   // 先生の操作は待たせずに、裏でAIの感想を作る
  const kv = env.BUNKO;
  if (!kv || !env.CLASS_PASS || !env.TEACHER_PASS) {
    return J({ error: "setup", message: "（先生へ）Worker に BUNKO・CLASS_PASS・TEACHER_PASS の設定が必要です" }, headers, 500);
  }
  const url = new URL(request.url);
  // 合言葉は日本語でもよいように、ページ側で encodeURIComponent して送っている
  const dec = v => { try { return decodeURIComponent(v || ""); } catch { return v || ""; } };
  const teacher = dec(request.headers.get("X-Teacher")) === env.TEACHER_PASS;
  if (!teacher && dec(request.headers.get("X-Pass")) !== env.CLASS_PASS) return J({ error: "pass" }, headers, 401);
  let body = {};
  if (request.method === "POST") { try { body = await request.json(); } catch { body = {}; } }

  // 公開中の作品の一覧
  if (path === "/bunko/works") {
    const works = (await listAll(kv, "w:")).map(k => k.metadata)
      .filter(m => m && m.status === "public").sort((a, b) => b.updated - a.updated);
    return J({ works }, headers);
  }
  // 1作品と、公開済みの感想（本人は確認待ちの自分の作品も見られる）
  if (path === "/bunko/work") {
    const id = url.searchParams.get("id") || "", token = url.searchParams.get("token") || "";
    const w = await kv.get("w:" + id, { type: "json" });
    const mine = !!(w && token && w.owner === token);
    if (!w || (w.status !== "public" && !teacher && !mine)) return J({ error: "notfound" }, headers, 404);
    const comments = [], now = Date.now();
    for (const k of await listAll(kv, "c:" + id + ":")) {
      const m = k.metadata;
      if (!m || (m.status !== "public" && !teacher)) continue;
      if (!teacher && m.ai && m.showAt > now) continue;           // AIの感想は時限まで見せない
      const c = await kv.get(k.name, { type: "json" }); if (c) comments.push(c);
    }
    comments.sort((a, b) => (a.showAt || a.created) - (b.showAt || b.created));
    return J({ work: withoutOwner(w), comments, mine }, headers);
  }
  // 作品を出す（同じ端末から同じ id で出し直すと、差し替えて確認待ちにもどる）
  if (path === "/bunko/submit") {
    const token = clip(body.token, 64);
    if (token.length < 16) return J({ error: "token" }, headers, 400);
    const text = clip(body.text, 20000).trim(), title = clip(body.title, 40).trim(), pen = clip(body.pen, 20).trim();
    if (!text || !title || !pen) return J({ error: "empty" }, headers, 400);
    let id = /^[a-z0-9]{6,24}$/.test(body.id || "") ? body.id : null;
    const old = id ? await kv.get("w:" + id, { type: "json" }) : null;
    if (old && old.owner !== token) return J({ error: "owner" }, headers, 403);
    if (!old) id = rid();
    else await deleteAiComments(kv, id);   // 出し直したら、前の版へのAIの感想は消す（再公開のときに作り直す）
    const lines = {};
    for (const k of ["ki", "sho", "ten", "ketsu"]) lines[k] = clip(body.lines && body.lines[k], 100);
    const now = Date.now();
    const w = { id, owner: token, pen, title, genre: clip(body.genre, 20), text, lines, bridged: !!body.bridged,
      status: "pending", created: old ? old.created : now, updated: now };
    await kv.put("w:" + id, JSON.stringify(w), { metadata: workMeta(w) });
    return J({ id, status: w.status }, headers);
  }
  // 自分の作品を取り下げる
  if (path === "/bunko/withdraw") {
    const w = await kv.get("w:" + clip(body.id, 30), { type: "json" });
    if (!w || w.owner !== body.token) return J({ error: "owner" }, headers, 403);
    await deleteWork(kv, w.id);
    return J({ ok: true }, headers);
  }
  // 感想を送る（先生が公開するまでは見えない）
  if (path === "/bunko/comment") {
    const w = await kv.get("w:" + clip(body.workId, 30), { type: "json" });
    if (!w || w.status !== "public") return J({ error: "notfound" }, headers, 404);
    const text = clip(body.text, 200).trim(), name = clip(body.name, 20).trim();
    if (!text || !name) return J({ error: "empty" }, headers, 400);
    const c = { id: rid(), workId: w.id, name, text, status: "pending", created: Date.now() };
    await kv.put("c:" + w.id + ":" + c.id, JSON.stringify(c), { metadata: { status: c.status } });
    return J({ ok: true }, headers);
  }

  // ── ここから先生用 ──
  if (!teacher) return J({ error: "teacher" }, headers, 401);
  if (path === "/bunko/admin") {
    const works = (await listAll(kv, "w:")).map(k => k.metadata).filter(Boolean).sort((a, b) => b.updated - a.updated);
    const comments = [];
    for (const k of await listAll(kv, "c:")) {
      if (k.metadata && k.metadata.status === "pending") { const c = await kv.get(k.name, { type: "json" }); if (c) comments.push(c); }
    }
    return J({ works, comments }, headers);
  }
  if (path === "/bunko/admin/set") {
    const st = body.status;
    if (body.kind === "w") {
      const w = await kv.get("w:" + clip(body.id, 30), { type: "json" });
      if (!w) return J({ error: "notfound" }, headers, 404);
      if (st === "delete") await deleteWork(kv, w.id);
      else if (["public", "pending", "hidden"].includes(st)) {
        w.status = st; await kv.put("w:" + w.id, JSON.stringify(w), { metadata: workMeta(w) });
        if (st === "public") {
          if (!(await hasAiComments(kv, w))) await later(makeAiComment(env, w));
        }
      }
    } else if (body.kind === "c") {
      const key = "c:" + clip(body.workId, 30) + ":" + clip(body.id, 30);
      const c = await kv.get(key, { type: "json" });
      if (!c) return J({ error: "notfound" }, headers, 404);
      if (st === "delete") await kv.delete(key);
      else if (st === "public") { c.status = "public"; await kv.put(key, JSON.stringify(c), { metadata: { status: "public" } }); }
    }
    return J({ ok: true }, headers);
  }
  // AIの感想：{id} があればその作品だけ作り直す。なければ、公開中でAIの感想がない作品すべてに作る
  if (path === "/bunko/admin/ai") {
    if (body.id) {
      const w = await kv.get("w:" + clip(body.id, 30), { type: "json" });
      if (!w) return J({ error: "notfound" }, headers, 404);
      const ok = await makeAiComment(env, w);
      return J({ made: ok ? 1 : 0, failed: ok ? 0 : 1 }, headers);
    }
    let made = 0, failed = 0;
    for (const k of await listAll(kv, "w:")) {
      if (!k.metadata || k.metadata.status !== "public") continue;
      const w = await kv.get(k.name, { type: "json" }); if (!w) continue;
      if (await hasAiComments(kv, w)) continue;
      if (await makeAiComment(env, w)) made++; else failed++;   // Gemini の RPM に配慮して1件ずつ
    }
    return J({ made, failed }, headers);
  }
  return J({ error: "path" }, headers, 404);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { headers });
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path.startsWith("/bunko")) {
      if (origin !== env.ALLOWED_ORIGIN) return J({ error: "origin" }, headers, 403);
      try { return await bunko(request, env, headers, path, ctx); }
      catch (e) { return J({ error: String(e.message || e) }, headers, 500); }
    }
    if (request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, models: MODELS, hint: true, bridge: true, bunko: !!env.BUNKO, aicomment: true }), { headers });
    }
    if (request.method !== "POST") return new Response("{}", { status: 405, headers });
    if (origin !== env.ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "origin" }), { status: 403, headers });
    }

    let body;
    try { body = await request.json(); } catch { body = {}; }
    const stage = ["ki", "sho", "ten", "ketsu"].includes(body.stage) ? body.stage : "ki";
    const genre = GENRES[body.genre] || GENRES.nichijo;
    const story = String(body.story || "").slice(0, 3000);
    const avoid = (Array.isArray(body.avoid) ? body.avoid : []).slice(-6).map(s => String(s).slice(0, 100));

    try {
      if (body.mode === "bridge") {
        const before = String(body.before || "").slice(-600);
        const after = String(body.after || "").slice(0, 400);
        const line = String(body.line || "").slice(0, 100);
        const system = `${BRIDGE_BASE}\n\nジャンル：${genre}`;
        const user = `前の場面の終わり：\n${before || "（なし）"}\n\n次の場面で起きること：${line}\n\n次の場面の書き出し：\n${after || "（なし）"}\n\nつなぎの文を出してください。`;
        const { result, model } = await callGemini(env, system, user, { models: HINT_MODELS, parse: parseBridge, temperature: 0.7 });
        return new Response(JSON.stringify({ bridge: result, model }), { headers });
      }

      if (body.mode === "hint") {
        const line = String(body.line || "").slice(0, 100);
        const draft = String(body.body || "").slice(-1500);
        const system = `${HINT_BASE}\n\nジャンル：${genre}\n\n${HINT_STAGE[stage]}`;
        let user = (story ? `ここまでの物語：\n${story}\n\n` : "")
          + `いまの段階で引いた一行：${line}\n\n生徒がいま書いている文章：\n${draft || "（まだ何も書いていない）"}\n\n問いを2つ出してください。`;
        if (avoid.length) user += `\n\n次の問いとは違う内容にしてください：\n${avoid.join("\n")}`;
        const { result, model } = await callGemini(env, system, user, { models: HINT_MODELS, parse: parseHints, temperature: 0.9 });
        return new Response(JSON.stringify({ hints: result, model }), { headers });
      }

      const system = `${BASE}\n\nジャンル：${genre}\n\n${STAGE_RULE[stage]}`;
      let user = stage === "ki"
        ? "書き出しの一文を一つだけ出してください。"
        : `ここまでの物語：\n${story}\n\n次の一文を一つだけ出してください。`;
      if (avoid.length) user += `\n\n次のものとは違う内容にしてください：\n${avoid.join("\n")}`;
      const { result, model } = await callGemini(env, system, user);
      return new Response(JSON.stringify({ line: result, model }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers });
    }
  },
};
