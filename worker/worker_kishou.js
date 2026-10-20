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
const AI_STYLE = 3;
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
// 読み手の顔ぶれ（名前・性格・書きぶり）は、先生用の画面から変えられる（KV の cfg:readers）。
// 学校のキャラクターなど、公開リポジトリに書きたくない名前は、ここではなく先生用の画面で入れる。
async function getReaders(kv) {
  const cfg = await kv.get("cfg:readers", { type: "json" });
  if (cfg && Array.isArray(cfg.readers) && cfg.readers.length) return { readers: cfg.readers, ver: AI_STYLE + ":" + cfg.updated, custom: true };
  return { readers: AI_READERS, ver: String(AI_STYLE), custom: false };
}
function cleanReaders(list) { // 先生が入れた設定を整える（1〜3人）
  const out = [];
  for (const r of (Array.isArray(list) ? list : []).slice(0, 3)) {
    const name = clip(r && r.name, 16).trim(), desc = clip(r && r.desc, 400).trim();
    if (!name || !desc) continue;
    const ex = (Array.isArray(r.ex) ? r.ex : []).map(x => clip(x, 80).trim()).filter(Boolean).slice(0, 4);
    out.push({ key: "r" + (out.length + 1), name, desc, ex });
  }
  return out;
}
function commentPrompt(readers) {
  const n = readers.length;
  return `高校3年生のクラスで、生徒が書いた短い物語をみんなで読み合っています。
あなたはそこに混ざっている${n}人の「AIの読み手」として、読んだあとのひとことを書きます。
国語の先生や本の評論家のような感想ではなく、感想欄にさっと書く短いひとことにしてください。
口調（ていねい語か、くだけた話し言葉か）は、それぞれの読み手の設定に従ってください。

${n}人：
${readers.map(r => `・${r.key}（${r.name}）：${r.desc}` + (r.ex && r.ex.length ? `\n　書きぶりの例：${r.ex.map(x => "「" + x + "」").join("")}` : "")).join("\n")}

守ること：
・書きぶりの例は、口調をつかむためだけのもの。例の言い回しをそのまま使わず、この作品に合わせて言う。
・それぞれ10〜60字。長くしない。${n > 1 ? n + "人の長さもばらばらにする。" : ""}
・きちんとした文章にまとめなくてよい。ていねい語でも、短く、言いさしのままでよい。
・「よかったところ＋気になったところ」のような、整った型にしない。思ったことを一つだけ言う。
${n > 1 ? `・${n}人で、同じ場面・同じ一文に触れない。言い回しや語尾もかぶらせない。\n` : ""}・作品に出てくる具体的なもの（人物、物、場面、一文）を一つは入れる。ただし、あらすじの説明はしない。
・ほめる言葉、点数、助言、まとめ、お説教は書かない。
・次の言葉は使わない：素晴らしい、見事、印象的、心温まる、感動、光って、作者、描写、表現、世界観、心情、引き込まれ、伝わって、余韻、絶妙、巧み、秀逸、共感。
・改行、絵文字、見出しは付けない。「！」は使わない。
・暴力の詳しい描写、性的な内容、自傷、差別、実在の人物・作品・商品名、家庭の事情には触れない。作品がこれらに触れていても、感想では掘り下げない。
出力は次の形の JSON だけ：{${readers.map(r => `"${r.key}":"…"`).join(",")}}`;
}
const AI_NG = /素晴らし|見事|印象的|心温ま|感動|光って|作者|描写|世界観|心情|引き込ま|伝わって|余韻|絶妙|巧み|秀逸|共感/;

const parseAiComments = readers => t => {
  if (!t) return null;
  let o;
  try { o = JSON.parse(t.replace(/^\s*```(json)?/i, "").replace(/```\s*$/, "").trim()); } catch { return null; }
  const out = {};
  for (const r of readers) {
    let s = String((o && o[r.key]) || "").replace(/\*\*/g, "").replace(/\s*\n\s*/g, "").trim();
    s = s.split(r.name + "：").join("").split(r.name + ":").join("").replace(new RegExp("^" + r.key + "[：:]\\s*"), "");
    s = s.replace(/！/g, "");
    const n = [...s].length;
    if (n < 6 || n > 90 || AI_NG.test(s)) return null;   // 長すぎ・AIっぽい言葉は、次のモデルで作り直す
    out[r.key] = s;
  }
  return out;
};

// 作品のAIの感想を、すべて消す（前の「AIの読み手」1人版もふくむ）
async function deleteAiComments(kv, id) {
  for (const k of await listAll(kv, "c:" + id + ":ai")) await kv.delete(k.name);
}
// いまの版・いまの読み手への感想が、もうあるか（文体や顔ぶれを変えたら、一括のボタンで作り直される）
async function hasAiComments(kv, w, ver) {
  for (const k of await listAll(kv, "c:" + w.id + ":ai-")) {
    const c = await kv.get(k.name, { type: "json" });
    if (c && c.persona && c.forUpdated === w.updated && String(c.style) === ver) return true;
  }
  return false;
}
// 読み手全員の感想を1回の問い合わせでまとめて作り、時間をずらして保存する。できたら true
async function makeAiComment(env, w, R) {
  R = R || await getReaders(env.BUNKO);
  const text = clip(w.text, 6000);
  const g = GENRES[w.genre] ? GENRES[w.genre].split("（")[0] : "";
  const user = `タイトル：『${w.title}』\nジャンル：${g}\n\n本文：\n${text}\n\n${R.readers.length}人の感想を JSON で出してください。`;
  let result;
  try { ({ result } = await callGemini(env, commentPrompt(R.readers), user, { models: HINT_MODELS, parse: parseAiComments(R.readers), temperature: 1.0, json: true })); }
  catch { return false; }
  // もう届いていた感想は、作り直しても同じ時刻に届いた扱いにする（消えてから出直さないように）
  const oldTimes = [];
  for (const k of await listAll(env.BUNKO, "c:" + w.id + ":ai-")) {
    const c = await env.BUNKO.get(k.name, { type: "json" });
    if (c && c.persona && c.forUpdated === w.updated) oldTimes.push(c.showAt);
  }
  oldTimes.sort((a, b) => a - b);
  await deleteAiComments(env.BUNKO, w.id);
  const now = Date.now();
  const order = R.readers.slice().sort(() => Math.random() - 0.5);   // だれが先に届くかも毎回ちがう
  for (let i = 0; i < order.length; i++) {
    const r = order[i], [lo, hi] = AI_SLOTS[i] || AI_SLOTS[AI_SLOTS.length - 1];
    const showAt = oldTimes[i] || now + Math.round((lo + Math.random() * (hi - lo)) * 60000);
    const c = { id: "ai-" + r.key, workId: w.id, name: r.name, persona: r.key, text: result[r.key], ai: true, status: "public", showAt, created: now, forUpdated: w.updated, style: R.ver };
    await env.BUNKO.put("c:" + w.id + ":ai-" + r.key, JSON.stringify(c), { metadata: { status: "public", ai: true, showAt } });
  }
  return true;
}

// ── 推敲の相棒（ブラッシュアップ）──
// AIは「見つける・たずねる・見本を見せる」。書きかえ案は最終手段（アプリ側でスタミナを使う）。
// ── 文庫の編集部（AIの掲載前チェック）──
// 出された作品は全部、AIが掲載前に読んで、気になる点を書きとめる。生徒に見せるのは、先生が［本人に返す］を押したときだけ。
const REVIEW_BASE = `あなたは、高校3年生のクラスの「文庫の編集部」です。受講者全員が読むクラス文庫に、生徒の短い物語を載せる前に読んで、気になる点を書き出します。
作品のおもしろさを決めるのではなく、「同じ学校の、いろいろな事情をかかえた生徒が読んでも、だれかを傷つけないか」だけを見ます。
見るところ：
・実在の人物や、この学校・この学校の先生・部活をはっきり思わせる人物が、殺される、犯人になる、ばかにされるなどしていないか（「うちの学校」「〇〇先生」「美術部の顧問」など）
・家庭の事情（施設で暮らしていること、親がいないこと、病気、貧しさなど）を、笑いや悪口の材料にしていないか
・いじめ、暴力、死を「されて当然」「よかった」と読める書き方になっていないか
・性的な内容、自傷をすすめるような内容、差別、だれかの個人情報
怖い話、事件の話、人が死ぬ話そのものは問題にしない。書き方だけを見る。
返し方：
・ok：気になる点がなければ true、あれば false。
・good：この作品のよいところを、具体的に一つ。40字以内。です・ます調。
・notes：気になる点（ok が true なら空）。多くても3つ。
　quote は本文からそのまま抜き出した部分（30字以内、一字もちがえない）。why はなぜ気になるか（50字以内）。how はどう直せば載せられるかの方向（50字以内）。書きかえた文は書かない。
・責める言い方をしない。編集者が書き手に返すメモのように、やわらかい、です・ます調で書く。
出力は JSON だけ：{"ok":true,"good":"…","notes":[{"quote":"…","why":"…","how":"…"}]}`;
const parseReview = text => t => {
  const o = jsonOf(t); if (!o || typeof o.ok !== "boolean") return null;
  const notes = (Array.isArray(o.notes) ? o.notes : []).map(n => ({ quote: String(n.quote || "").trim(), why: String(n.why || "").trim(), how: String(n.how || "").trim() }))
    .filter(n => n.why && len(n.why) <= 90 && n.how && len(n.how) <= 90).map(n => ({ ...n, quote: text.includes(n.quote) ? n.quote : "" })).slice(0, 3);
  const good = String(o.good || "").trim().slice(0, 80);
  return { ok: o.ok && !notes.length, good, notes };
};
async function makeReview(env, id) {
  const kv = env.BUNKO;
  const w = await kv.get("w:" + id, { type: "json" }); if (!w) return false;
  let result;
  try { ({ result } = await callGemini(env, REVIEW_BASE, `タイトル：『${w.title}』\n\n本文：\n${clip(w.text, 8000)}\n\nJSON で出してください。`, { models: HINT_MODELS, parse: parseReview(w.text), temperature: 0.2, json: true })); }
  catch { return false; }
  const cur = await kv.get("w:" + id, { type: "json" }); if (!cur || cur.updated !== w.updated) return false;   // そのあいだに出し直されていたら捨てる
  cur.review = { ...result, at: Date.now() };
  await kv.put("w:" + id, JSON.stringify(cur), { metadata: workMeta(cur) });
  return true;
}

const POLISH_RULES = `・暴力の詳しい描写、性的な内容、自傷、差別、実在の人物・作品・商品名、家庭の事情には触れない。
・ほめ言葉、点数、評価、お説教は書かない。高校生にわかる、やさしい言葉で書く。`;
const POINTS_BASE = `あなたは高校3年生の創作の授業で、生徒が自分の物語を推敲するのを手伝う係です。
文章を直すのは生徒です。あなたは書きかえた文を出しません。
本文の中から「ここを直すと、もっと場面が見えてくる」という文を3つ選び、それぞれに短い問いを付けてください。
守ること：
・quote は、本文からそのまま抜き出した一文（または一文の一部）。40字以内。本文と一字でもちがってはいけない。
・q は、生徒が自分で直し方を考えられる問い。40字以内。「？」で終わる。答えや書きかえた文は書かない。
・よく効く問いの例：気持ちを「悲しかった」と言うかわりに、体の動きや目に入ったもので見せられる？／ここで何の音がしていた？／この台詞、言ったあと相手はどうした？／この一文、二つに分けたらどうなる？
・3つは別々の場面から選ぶ。
${POLISH_RULES}
出力は JSON だけ：{"points":[{"quote":"…","q":"…"},{"quote":"…","q":"…"},{"quote":"…","q":"…"}]}`;
const ADVICE_BASE = `あなたは高校3年生の創作の授業で、生徒が推敲で困っている一文について、直し方の方向を教える係です。
文章を直すのは生徒です。生徒の一文を書きかえた文は出しません。
直し方の方向を3つ出し、それぞれに「別の文」で作った短い見本を付けてください。
守ること：
・name は直し方の名前（例：音を足す、短く切る、台詞にする、体の動きで見せる、たとえを使う、順番を入れかえる）。10字以内。
・how は、生徒の一文にどう当てはめるかのヒント。40字以内。書きかえた文は書かない。
・before と after は、生徒の一文とは関係のない、あなたが作った別の短い例文。生徒の文の言葉を使わない。それぞれ30字以内。
${POLISH_RULES}
出力は JSON だけ：{"tips":[{"name":"…","how":"…","before":"…","after":"…"},…3つ]}`;
const REWRITE_BASE = `あなたは高校3年生の創作の授業で、生徒の推敲を手伝う係です。
生徒は、自分で直そうとしてもどうしても手が止まった一文について、最後の手段として書きかえ案を1つだけ求めています。
守ること：
・書きかえ案を1つだけ出す。前置きや説明は付けない。
・生徒の文の内容と人物はそのままにして、場面が目に浮かぶように直す。
・元の文の1.5倍より長くしない。80字以内。
・前後の文と、生徒の文体（一人称、「だ・である」か「です・ます」か）に合わせる。
・新しい人物や出来事を足さない。
${POLISH_RULES}
出力は JSON だけ：{"rewrite":"…"}`;
const jsonOf = t => { try { return JSON.parse(String(t || "").replace(/^\s*```(json)?/i, "").replace(/```\s*$/, "").trim()); } catch { return null; } };
const len = s => [...String(s || "")].length;
const parsePoints = text => t => {
  const o = jsonOf(t); if (!o || !Array.isArray(o.points)) return null;
  const out = o.points.map(p => ({ quote: String(p.quote || "").trim(), q: String(p.q || "").trim() }))
    .filter(p => p.quote && len(p.quote) <= 60 && text.includes(p.quote) && p.q && len(p.q) <= 60);   // 本文にない引用は捨てる
  return out.length ? out.slice(0, 3) : null;
};
const parseTips = sentence => t => {
  const o = jsonOf(t); if (!o || !Array.isArray(o.tips)) return null;
  const out = o.tips.map(x => ({ name: String(x.name || "").trim(), how: String(x.how || "").trim(), before: String(x.before || "").trim(), after: String(x.after || "").trim() }))
    .filter(x => x.name && len(x.name) <= 16 && x.how && len(x.how) <= 70 && x.before && x.after && len(x.after) <= 50 && !sentence.includes(x.after));
  return out.length >= 2 ? out.slice(0, 3) : null;
};
const parseRewrite = sentence => t => {
  const o = jsonOf(t); const r = o && String(o.rewrite || "").replace(/[〔〕]/g, "").replace(/\s*\n\s*/g, "").trim();
  return r && len(r) >= 2 && len(r) <= Math.max(80, len(sentence) * 2) && r !== sentence ? r : null;
};

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
  rv: w.review ? (w.review.ok ? "ok" : "ng") : null, obi: w.obi == null ? null : w.obi,
  chars: [...w.text.replace(/\s/g, "")].length, created: w.created, updated: w.updated });
const withoutOwner = w => { const { owner, ...rest } = w; return rest; };
// 査読のメモは、先生と、返却された本人にだけ見せる
const workView = (w, teacher, mine) => { const v = withoutOwner(w); if (!teacher && !(mine && w.status === "returned")) { delete v.review; delete v.returnNote; } return v; };
async function deleteWork(kv, id) {
  await kv.delete("w:" + id);
  for (const k of await listAll(kv, "c:" + id + ":")) await kv.delete(k.name);
  for (const k of await listAll(kv, "o:" + id + ":")) await kv.delete(k.name);
}

// ── 帯（おすすめの帯）──
// 帯は、文庫の編集部（AI）が読んで気になる点がなければそのまま載る。気になる点があれば先生の確認待ち。
// あわせて、AIの読み手が「帯だけ」を読んで、どんな話かを予想する（帯の手ごたえ）。
function obiPrompt(readers) {
  return `高校3年生のクラス文庫で、生徒が友だちの作品（または自分の作品）に「本の帯」を書きました。帯には、キャッチコピーと短い推薦文が書かれています。
次の2つをしてください。
1. 文庫の編集部として、帯がだれかを傷つけないかだけを見る。悪口・からかい、実在の人物や先生をばかにする内容、性的な内容、差別、個人情報があれば ok を false にして、why に理由を40字以内で書く。なければ ok は true、why は空。ネタバレや、帯のうまい・へたは問題にしない。
2. 次の読み手が、本文を読まずに「タイトルと帯だけ」を見て、どんな話だと思うかを、それぞれの口調で予想する。1人20〜60字。「〜な話かな」「〜っぽい」のように、予想として言う。ほめたり、帯の出来を評価したりしない。
読み手：
${readers.map(r => `・${r.key}（${r.name}）：${r.desc}`).join("\n")}
出力は JSON だけ：{"ok":true,"why":"","guess":{${readers.map(r => `"${r.key}":"…"`).join(",")}}}`;
}
const parseObi = readers => t => {
  const o = jsonOf(t); if (!o || typeof o.ok !== "boolean") return null;
  const guess = {};
  for (const r of readers) { const g = String((o.guess && o.guess[r.key]) || "").replace(/\s*\n\s*/g, "").trim(); if (g && len(g) <= 100) guess[r.key] = { name: r.name, text: g }; }
  return { ok: o.ok, why: String(o.why || "").slice(0, 80), guess };
};
const OBIQ_BASE = `高校3年生が、クラス文庫の作品に「本の帯」（キャッチコピーと短い推薦文）を書こうとしています。
あなたは帯を書きません。かわりに、帯の材料になる「推しどころ」を引き出す問いを3つ出してください。
・作品の中身に合わせた、具体的な問いにする（場面、人物、物、一文などに触れる）。
・1つ40字以内。「？」で終わる。答えや帯の例は書かない。
・3つは、「一番心が動いた場面」「だれに読んでほしいか」「読む前の人に伝えたいこと」の方向でばらけさせる。
・暴力の詳しい描写、性的な内容、自傷、差別、実在の人物・作品・商品名、家庭の事情には触れない。
出力は JSON だけ：{"qs":["…","…","…"]}`;
const parseQs = t => { const o = jsonOf(t); const qs = (o && Array.isArray(o.qs) ? o.qs : []).map(x => String(x).trim()).filter(x => x && len(x) <= 60 && /[？?]$/.test(x)); return qs.length >= 2 ? qs.slice(0, 3) : null; };
const obiView = o => { const { owner, ...rest } = o; return rest; };
// その作品の、いちばん新しい公開中の帯の色を、作品の metadata に写す（棚の背表紙に帯を描くため）
async function syncObi(kv, workId) {
  const w = await kv.get("w:" + workId, { type: "json" }); if (!w) return;
  let latest = null;
  for (const k of await listAll(kv, "o:" + workId + ":")) if (k.metadata && k.metadata.status === "public" && (!latest || k.metadata.created > latest.created)) latest = k.metadata;
  const style = latest ? latest.style : null;
  if (w.obi !== style) { w.obi = style; await kv.put("w:" + w.id, JSON.stringify(w), { metadata: workMeta(w) }); }
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
    const all = (await listAll(kv, "w:")).map(k => k.metadata).filter(Boolean);
    const works = all.filter(m => m.status === "public").sort((a, b) => b.updated - a.updated);
    return J({ works, pending: all.filter(m => m.status === "pending").length }, headers);
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
    const obis = [];
    for (const k of await listAll(kv, "o:" + id + ":")) {
      if (!k.metadata || (k.metadata.status !== "public" && !teacher)) continue;
      const o = await kv.get(k.name, { type: "json" }); if (o) obis.push(obiView(o));
    }
    obis.sort((a, b) => a.created - b.created);
    return J({ work: workView(w, teacher, mine), comments, obis, mine }, headers);
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
    await later(makeReview(env, id));   // 文庫の編集部（AI）が掲載前に読む
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
  // 帯を巻く
  if (path === "/bunko/obi") {
    const w = await kv.get("w:" + clip(body.workId, 30), { type: "json" });
    if (!w || w.status !== "public") return J({ error: "notfound" }, headers, 404);
    const token = clip(body.token, 64), pen = clip(body.pen, 20).trim(), cat = clip(body.catch, 24).trim(), txt = clip(body.body, 100).trim();
    const style = [0, 1, 2].includes(body.style) ? body.style : 0;
    if (token.length < 16 || !pen || !cat || !txt) return J({ error: "empty", message: "キャッチコピーと推薦文を書いてください。" }, headers, 400);
    const R = await getReaders(kv);
    let check = null;
    try { ({ result: check } = await callGemini(env, obiPrompt(R.readers), `タイトル：『${w.title}』\nジャンル：${GENRES[w.genre] ? GENRES[w.genre].split("（")[0] : ""}\n\nキャッチコピー：${cat}\n推薦文：${txt}\n推薦者：${pen}\n\nJSON で出してください。`, { models: HINT_MODELS, parse: parseObi(R.readers), temperature: 0.8, json: true })); } catch { check = null; }
    const now = Date.now();
    const o = { id: rid(), workId: w.id, owner: token, pen, catch: cat, body: txt, style, status: check && check.ok ? "public" : "pending",
      review: check ? { ok: check.ok, why: check.why } : null, guess: check ? check.guess : {}, created: now };
    await kv.put("o:" + w.id + ":" + o.id, JSON.stringify(o), { metadata: { status: o.status, style, created: now } });
    if (o.status === "public") await syncObi(kv, w.id);
    return J({ obi: obiView(o) }, headers);
  }
  // 自分の巻いた帯をはずす
  if (path === "/bunko/obi/delete") {
    const key = "o:" + clip(body.workId, 30) + ":" + clip(body.id, 30);
    const o = await kv.get(key, { type: "json" });
    if (!o || (o.owner !== body.token && !teacher)) return J({ error: "owner" }, headers, 403);
    await kv.delete(key); await syncObi(kv, o.workId);
    return J({ ok: true }, headers);
  }
  // 帯の相棒：推しどころを引き出す問い
  if (path === "/bunko/obi/questions") {
    const w = await kv.get("w:" + clip(body.workId, 30), { type: "json" });
    if (!w || w.status !== "public") return J({ error: "notfound" }, headers, 404);
    const { result } = await callGemini(env, OBIQ_BASE, `タイトル：『${w.title}』\n\n本文：\n${clip(w.text, 6000)}\n\nJSON で出してください。`, { models: HINT_MODELS, parse: parseQs, temperature: 0.8, json: true });
    return J({ qs: result }, headers);
  }
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
    const obis = [];
    for (const k of await listAll(kv, "o:")) {
      if (k.metadata && k.metadata.status === "pending") { const o = await kv.get(k.name, { type: "json" }); if (o) obis.push(obiView(o)); }
    }
    return J({ works, comments, obis }, headers);
  }
  if (path === "/bunko/admin/set") {
    const st = body.status;
    if (body.kind === "w") {
      const w = await kv.get("w:" + clip(body.id, 30), { type: "json" });
      if (!w) return J({ error: "notfound" }, headers, 404);
      if (st === "delete") await deleteWork(kv, w.id);
      else if (["public", "pending", "hidden", "returned"].includes(st)) {
        w.status = st;
        if (st === "returned") { w.returnNote = clip(body.note, 300).trim(); w.returnedAt = Date.now(); }   // 本人に査読を見せて、書き直してもらう
        await kv.put("w:" + w.id, JSON.stringify(w), { metadata: workMeta(w) });
        if (st === "public") {
          const R = await getReaders(kv);
          if (!(await hasAiComments(kv, w, R.ver))) await later(makeAiComment(env, w, R));
        }
      }
    } else if (body.kind === "o") {
      const key = "o:" + clip(body.workId, 30) + ":" + clip(body.id, 30);
      const o = await kv.get(key, { type: "json" });
      if (!o) return J({ error: "notfound" }, headers, 404);
      if (st === "delete") await kv.delete(key);
      else if (st === "public") { o.status = "public"; await kv.put(key, JSON.stringify(o), { metadata: { status: "public", style: o.style, created: o.created } }); }
      await syncObi(kv, o.workId);
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
    let made = 0, failed = 0; const R = await getReaders(kv);
    for (const k of await listAll(kv, "w:")) {
      if (!k.metadata || k.metadata.status !== "public") continue;
      const w = await kv.get(k.name, { type: "json" }); if (!w) continue;
      if (await hasAiComments(kv, w, R.ver)) continue;
      if (await makeAiComment(env, w, R)) made++; else failed++;   // Gemini の RPM に配慮して1件ずつ
    }
    return J({ made, failed }, headers);
  }
  // 編集部（AI）の査読をやり直す
  if (path === "/bunko/admin/review") {
    const ok = await makeReview(env, clip(body.id, 30));
    const w = await kv.get("w:" + clip(body.id, 30), { type: "json" });
    return J({ ok, review: w && w.review }, headers);
  }
  // AIの読み手の顔ぶれ：GET で読む／POST {readers} で保存／POST {reset:true} ではじめの3人にもどす
  if (path === "/bunko/admin/readers") {
    if (request.method === "POST") {
      if (body.reset) await kv.delete("cfg:readers");
      else {
        const readers = cleanReaders(body.readers);
        if (!readers.length) return J({ error: "empty", message: "読み手を1人以上入れてください（名前と性格・話し方は必須）" }, headers, 400);
        await kv.put("cfg:readers", JSON.stringify({ readers, updated: Date.now() }));
      }
    }
    const R = await getReaders(kv);
    return J({ readers: R.readers, custom: R.custom }, headers);
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
      return new Response(JSON.stringify({ ok: true, models: MODELS, hint: true, bridge: true, bunko: !!env.BUNKO, aicomment: true, polish: true, obi: true }), { headers });
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
      if (body.mode === "polish_points") {
        const text = String(body.text || "").slice(0, 8000);
        const user = `タイトル：『${clip(body.title, 40)}』\nジャンル：${genre}\n\n本文：\n${text}\n\n直しどころを3つ、JSON で出してください。`;
        const { result, model } = await callGemini(env, POINTS_BASE, user, { models: HINT_MODELS, parse: parsePoints(text), temperature: 0.7, json: true });
        return new Response(JSON.stringify({ points: result, model }), { headers });
      }
      if (body.mode === "polish_advice" || body.mode === "polish_rewrite") {
        const sentence = String(body.sentence || "").trim().slice(0, 200);
        if (!sentence) return new Response(JSON.stringify({ error: "empty" }), { status: 400, headers });
        const context = String(body.context || "").slice(0, 600);
        const user = `ジャンル：${genre}\n\n前後の文章：\n${context}\n\n困っている一文：${sentence}\n\nJSON で出してください。`;
        if (body.mode === "polish_advice") {
          const { result, model } = await callGemini(env, ADVICE_BASE, user, { models: HINT_MODELS, parse: parseTips(sentence), temperature: 0.8, json: true });
          return new Response(JSON.stringify({ tips: result, model }), { headers });
        }
        const { result, model } = await callGemini(env, REWRITE_BASE, user, { models: HINT_MODELS, parse: parseRewrite(sentence), temperature: 0.7, json: true });
        return new Response(JSON.stringify({ rewrite: result, model }), { headers });
      }

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
