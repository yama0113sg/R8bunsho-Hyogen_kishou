// ============================================================
//  起承転結 用 中継 Worker（worker_kishou.js）
//  いま動いている tsukutte の Worker とは別物です。
//  変数：GEMINI_API_KEY（Secret）／ALLOWED_ORIGIN = https://yama0113sg.github.io
//  POST {stage, genre, story, avoid}            → {line}   一行を引く
//  POST {mode:"hint", stage, genre, story, line, body, avoid} → {hints:[問い,問い]}
//  POST {mode:"bridge", stage, genre, before, line, after}    → {bridge}   整えるときのつなぎの文
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
    "Access-Control-Allow-Headers": "Content-Type",
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

async function callGemini(env, system, user, { models = MODELS, parse = cleanLine, temperature = 1.1 } = {}) {
  let lastErr = "";
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: 1024 },
      }),
    });
    if (!res.ok) { lastErr = `${model}:${res.status}`; continue; }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    const result = parse(text);
    if (result && result.length) return { result, model };
    lastErr = `${model}:empty`;
  }
  throw new Error(lastErr || "no model");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, models: MODELS, hint: true, bridge: true }), { headers });
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
