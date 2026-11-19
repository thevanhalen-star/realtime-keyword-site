const CACHE_SECONDS = 600;
const RETRY_CACHE_SECONDS = 60;
const TREND_LIMIT = 10;
const CANDIDATE_LIMIT = 20;
const CACHE_VERSION = "v12-filtered";

// 광고 정책상 문제가 될 수 있는 키워드(성인물, 불법 촬영·성착취, 도박, 마약 거래, 극단적 선택 방법 등).
// 공백을 뺀 소문자 기준의 부분 일치이며, 일반 뉴스 키워드는 일부러 넣지 않았다.
const BLOCKED_TERMS = [
  "야동", "포르노", "porn", "av배우", "성인영화", "성인물", "성인용품", "성인웹툰", "야설", "무삭제",
  "섹스", "알몸", "음란", "안마방", "룸살롱", "유흥업소", "성매매", "조건만남", "원나잇",
  "몰카", "불법촬영", "리벤지포르노", "성착취", "n번방", "딥페이크영상",
  "토토사이트", "스포츠토토", "먹튀", "카지노", "바카라", "슬롯머신", "도박", "파워볼", "사다리게임", "베팅사이트",
  "필로폰", "히로뽕", "엑스터시", "코카인", "대마초구매", "마약구매", "마약판매",
  "자살방법", "자살사이트", "동반자살", "자해방법", "극단선택방법"
];

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname === "/api/trends") {
      return handleTrends(request, env, context);
    }

    if (url.pathname === "/archive" || url.pathname.startsWith("/archive/") || url.pathname === "/sitemap-archive.xml") {
      return handleArchive(request, env, context, url);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleTrends(request, env, context) {
  const cache = caches.default;
  const origin = new URL(request.url).origin;
  const cacheKey = new Request(`${origin}/api/trends-cache-${CACHE_VERSION}`);
  const cached = await cache.match(cacheKey);

  if (cached) {
    return withCors(cached);
  }

  const errors = {};
  const [naverRaw, googleRaw, daumRaw] = await Promise.all([
    safeFetch("naver", fetchNaverTrends, errors),
    safeFetch("google", fetchGoogleTrends, errors),
    safeFetch("daum", fetchDaumTrends, errors)
  ]);
  const naver = filterRows(naverRaw);
  const google = filterRows(googleRaw);
  const daum = filterRows(daumRaw);

  const response = jsonResponse({
    updatedAt: new Date().toISOString(),
    data: { naver, google, daum },
    ...(Object.keys(errors).length ? { errors } : {})
  });

  // 한 곳이라도 비어 있으면 짧게만 캐시해서 빨리 다시 시도한다.
  const complete = naver.length && google.length && daum.length;
  const seconds = complete ? CACHE_SECONDS : RETRY_CACHE_SECONDS;
  response.headers.set("Cache-Control", `public, max-age=${seconds}`);
  context.waitUntil(cache.put(cacheKey, response.clone()));
  if (complete) {
    context.waitUntil(saveSnapshot(env, { naver, google, daum }));
  }
  return withCors(response);
}

// ---- 키워드 아카이브 (Cloudflare KV, 바인딩 이름: ARCHIVE) ----
// 하루 1개 문서(day:YYYY-MM-DD)에 한국 시간 기준 시간대별 스냅샷을 쌓는다.
const PROVIDERS = [["naver", "네이버"], ["google", "구글"], ["daum", "다음"]];
const KST_OFFSET = 9 * 3600 * 1000;
const MIN_SNAPS_TO_INDEX = 6;

function kstParts(date = new Date()) {
  const iso = new Date(date.getTime() + KST_OFFSET).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

async function saveSnapshot(env, lists) {
  if (!env.ARCHIVE) return;
  try {
    const { day, hour } = kstParts();
    const key = `day:${day}`;
    const doc = (await env.ARCHIVE.get(key, "json")) || { date: day, snaps: {} };
    if (doc.snaps[hour]) return;
    doc.snaps[hour] = {};
    for (const [id] of PROVIDERS) {
      doc.snaps[hour][id] = lists[id].map((row) => row.query);
    }
    await env.ARCHIVE.put(key, JSON.stringify(doc));
  } catch (error) {
    // 저장 실패가 화면 응답에 영향을 주지 않도록 무시한다.
  }
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 한 서비스의 하루 기록을 키워드별로 모은다: 확인된 시간대 수, 최고 순위, 처음·마지막 시각.
function aggregate(docs, provider) {
  const map = new Map();
  for (const doc of docs) {
    for (const hour of Object.keys(doc.snaps).sort()) {
      (doc.snaps[hour][provider] || []).forEach((query, index) => {
        const item = map.get(query) || { query, count: 0, best: 99, first: hour, last: hour };
        item.count += 1;
        item.best = Math.min(item.best, index + 1);
        item.last = hour;
        map.set(query, item);
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.best - b.best);
}

function pageShell({ title, description, canonical, noindex, body }) {
  const robots = noindex ? "noindex, follow" : "index, follow, max-image-preview:large";
  return `<!doctype html>
<html lang="ko">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-RQ51W3D2QJ"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-RQ51W3D2QJ');
</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3423115341381444" crossorigin="anonymous"></script>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<title>${esc(title)} - Jump Keyword</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="https://www.jumpkeyword.com${canonical}">
<meta property="og:type" content="article">
<meta property="og:locale" content="ko_KR">
<meta property="og:site_name" content="Jump Keyword">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="https://www.jumpkeyword.com${canonical}">
<meta property="og:image" content="https://www.jumpkeyword.com/og-image.png">
<style>
*{box-sizing:border-box}
body{margin:0;background:#f4f5f7;color:#151515;font-family:Arial,"Malgun Gothic",sans-serif;line-height:1.75}
.page{max-width:920px;margin:0 auto;padding:34px 18px}
.card{background:#fff;border:1px solid #dfe2e7;border-radius:8px;padding:32px}
h1{margin:0 0 10px;font-size:28px;line-height:1.35}
h2{margin:30px 0 10px;font-size:20px}
p,li{margin:0 0 12px}
a{color:#c9121a;font-weight:700}
.lead{color:#444;font-size:16px;padding-bottom:14px;border-bottom:1px solid #e8eaed}
.crumb{font-size:13px;margin:0 0 14px}.crumb a{color:#555;font-weight:400}
.table-wrap{overflow-x:auto;margin:10px 0 18px}
table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.55}
th,td{border:1px solid #e1e4e8;padding:8px 10px;text-align:left}
th{background:#f6f7f9}
.note{font-size:13px;color:#666}
.days{list-style:none;padding:0}.days li{padding:10px 0;border-top:1px solid #e8eaed;margin:0}
.nav{display:flex;gap:14px;flex-wrap:wrap;margin-top:32px;padding-top:20px;border-top:1px solid #e8eaed;font-size:14px}.nav a{color:#222}
@media(max-width:680px){.card{padding:22px}h1{font-size:24px}}
</style>
</head>
<body>
<main class="page">
  <article class="card">
${body}
    <nav class="nav" aria-label="사이트 정보">
      <a href="/">홈</a>
      <a href="/archive">키워드 기록</a>
      <a href="/blog/">트렌드 칼럼</a>
      <a href="/guide">이용 가이드</a>
      <a href="/faq">자주 묻는 질문</a>
      <a href="/about">사이트 소개</a>
      <a href="/data-source">데이터 출처</a>
      <a href="/privacy">개인정보처리방침</a>
      <a href="/terms">이용약관·면책</a>
      <a href="/contact">문의</a>
    </nav>
  </article>
</main>
</body>
</html>`;
}

function htmlResponse(html, status, seconds) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, max-age=${seconds}`
    }
  });
}

function rankTable(rows, limit) {
  const body = rows.slice(0, limit).map((item, i) =>
    `<tr><td>${i + 1}</td><td>${esc(item.query)}</td><td>${item.count}회</td><td>${item.best}위</td><td>${item.first}시 ~ ${item.last}시</td></tr>`
  ).join("");
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>키워드</th><th>확인된 시간대</th><th>최고 순위</th><th>처음~마지막 확인</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function dayPage(doc) {
  const snaps = Object.keys(doc.snaps).length;
  const sections = PROVIDERS.map(([id, label]) => ({ id, label, rows: aggregate([doc], id) }));
  const sets = sections.map((s) => new Set(s.rows.map((r) => r.query)));
  const common = [...sets[0]].filter((q) => sets[1].has(q) && sets[2].has(q));
  const twoPlus = [...new Set(sections.flatMap((s) => s.rows.map((r) => r.query)))]
    .filter((q) => sets.filter((set) => set.has(q)).length >= 2);

  const summary = [`<li>이날 한국 시간 기준 ${snaps}개 시간대에서 목록을 확인했습니다.</li>`];
  for (const s of sections) {
    if (s.rows[0]) {
      summary.push(`<li>${s.label}에서 가장 오래 머문 키워드는 <strong>${esc(s.rows[0].query)}</strong>(${s.rows[0].count}개 시간대)이며, 최고 ${s.rows[0].best}위까지 올랐습니다.</li>`);
    }
  }
  summary.push(common.length
    ? `<li>세 서비스 목록에 모두 오른 키워드: ${common.slice(0, 10).map(esc).join(", ")}</li>`
    : `<li>세 서비스 목록에 모두 오른 키워드는 없었습니다.</li>`);
  if (twoPlus.length) {
    summary.push(`<li>두 곳 이상에 오른 키워드는 모두 ${twoPlus.length}개였습니다.</li>`);
  }

  const tables = sections.map((s) => `<h2>${s.label} 급상승 키워드</h2>\n${rankTable(s.rows, 15)}`).join("\n");
  const body = `    <p class="crumb"><a href="/">홈</a> &gt; <a href="/archive">키워드 기록</a></p>
    <h1>${doc.date} 급상승 키워드 기록</h1>
    <p class="lead">${doc.date} 하루 동안 네이버·구글·다음의 급상승 목록에 오른 키워드를 시간대별로 모아 정리한 기록입니다.</p>
    <h2>하루 요약</h2>
    <ul>${summary.join("")}</ul>
${tables}
    <p class="note">시간대는 한국 시간이며, 사이트 방문 등으로 목록을 새로 받아온 시점에 저장되므로 모든 시간대가 기록되지는 않을 수 있습니다. 표의 "확인된 시간대"는 그 키워드가 목록에 있던 시간대의 수이고 실제 검색량이 아닙니다. 불쾌하거나 부적절한 키워드는 자동으로 제외됩니다. 자세한 기준은 <a href="/data-source">데이터 출처</a>를 참고하세요.</p>`;
  return pageShell({
    title: `${doc.date} 급상승 키워드 기록 (네이버·구글·다음)`,
    description: `${doc.date} 네이버·구글·다음 급상승 키워드를 시간대별로 모아 정리했습니다. 가장 오래 머문 키워드와 세 곳에 함께 오른 키워드를 확인하세요.`,
    canonical: `/archive/${doc.date}`,
    noindex: snaps < MIN_SNAPS_TO_INDEX,
    body
  });
}

async function listDays(env) {
  const days = [];
  let cursor;
  do {
    const page = await env.ARCHIVE.list({ prefix: "day:", cursor });
    days.push(...page.keys.map((k) => k.name.slice(4)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return days.sort().reverse();
}

async function indexPage(env) {
  if (!env.ARCHIVE) {
    return pageShell({
      title: "키워드 기록", description: "날짜별 급상승 키워드 기록입니다.", canonical: "/archive", noindex: true,
      body: `    <h1>키워드 기록</h1><p class="lead">기록을 준비하고 있습니다. 잠시 뒤 다시 확인해 주세요.</p>`
    });
  }
  const days = await listDays(env);
  const recent = (await Promise.all(days.slice(0, 7).map((d) => env.ARCHIVE.get(`day:${d}`, "json")))).filter(Boolean);
  const weekly = PROVIDERS.map(([id, label]) =>
    `<h2>최근 ${recent.length}일 동안 자주 오른 ${label} 키워드</h2>\n${rankTable(aggregate(recent, id), 10)}`
  ).join("\n");
  const list = (await Promise.all(days.slice(0, 60).map(async (d) => {
    const doc = await env.ARCHIVE.get(`day:${d}`, "json");
    return doc ? `<li><a href="/archive/${d}">${d} 급상승 키워드</a> <span class="note">· ${Object.keys(doc.snaps).length}개 시간대 기록</span></li>` : "";
  }))).join("");
  const body = `    <p class="crumb"><a href="/">홈</a></p>
    <h1>급상승 키워드 기록</h1>
    <p class="lead">네이버·구글·다음의 급상승 목록을 날짜별로 저장해 둔 기록입니다. 어떤 키워드가 얼마나 오래 머물렀는지 되짚어 볼 수 있습니다.</p>
${recent.length ? weekly : "<p>아직 기록이 없습니다.</p>"}
    <h2>날짜별 기록</h2>
    <ul class="days">${list}</ul>
    <p class="note">표의 횟수는 목록에 오른 시간대(한 시간 단위)의 수이며 실제 검색량이 아닙니다. 기록은 사이트가 목록을 받아온 시점에 저장됩니다.</p>`;
  return pageShell({
    title: "급상승 키워드 기록 - 날짜별 네이버·구글·다음",
    description: "네이버·구글·다음 급상승 키워드를 날짜별로 저장한 기록입니다. 최근 자주 오른 키워드와 하루 요약을 확인하세요.",
    canonical: "/archive", noindex: recent.length === 0, body
  });
}

async function handleArchive(request, env, context, url) {
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}?v=${CACHE_VERSION}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let response;
  const dayMatch = url.pathname.match(/^\/archive\/(\d{4}-\d{2}-\d{2})\/?$/);

  if (url.pathname === "/sitemap-archive.xml") {
    const days = env.ARCHIVE ? await listDays(env) : [];
    const docs = await Promise.all(days.slice(0, 400).map((d) => env.ARCHIVE.get(`day:${d}`, "json")));
    const urls = docs.filter((doc) => doc && Object.keys(doc.snaps).length >= MIN_SNAPS_TO_INDEX)
      .map((doc) => `  <url>\n    <loc>https://www.jumpkeyword.com/archive/${doc.date}</loc>\n    <lastmod>${doc.date}</lastmod>\n  </url>`).join("\n");
    response = new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" }
    });
  } else if (dayMatch) {
    const doc = env.ARCHIVE ? await env.ARCHIVE.get(`day:${dayMatch[1]}`, "json") : null;
    if (!doc) {
      return htmlResponse(pageShell({
        title: "기록이 없습니다", description: "해당 날짜의 기록이 없습니다.", canonical: url.pathname, noindex: true,
        body: `    <h1>기록이 없습니다</h1><p class="lead">해당 날짜의 기록이 없습니다. <a href="/archive">키워드 기록 목록</a>에서 다른 날짜를 선택해 주세요.</p>`
      }), 404, 60);
    }
    const isToday = dayMatch[1] === kstParts().day;
    response = htmlResponse(dayPage(doc), 200, isToday ? 600 : 3600);
  } else if (url.pathname === "/archive" || url.pathname === "/archive/") {
    response = htmlResponse(await indexPage(env), 200, 600);
  } else {
    return htmlResponse(pageShell({
      title: "페이지를 찾을 수 없습니다", description: "페이지를 찾을 수 없습니다.", canonical: "/archive", noindex: true,
      body: `    <h1>페이지를 찾을 수 없습니다</h1><p class="lead"><a href="/archive">키워드 기록</a>으로 이동해 주세요.</p>`
    }), 404, 60);
  }

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function isBlocked(query) {
  const text = String(query || "").toLowerCase().replace(/\s+/g, "");
  return BLOCKED_TERMS.some((term) => text.includes(term));
}

// 차단 키워드를 빼고 TREND_LIMIT개까지 다시 채운 뒤 순위를 1부터 다시 매긴다.
function filterRows(rows) {
  return rows
    .filter((item) => !isBlocked(item.query))
    .slice(0, TREND_LIMIT)
    .map((item, index) => ({ ...item, position: index + 1 }));
}

async function safeFetch(name, fetcher, errors) {
  try {
    return await fetcher();
  } catch (error) {
    errors[name] = String(error.message || error);
    return [];
  }
}

async function fetchNaverTrends() {
  const response = await fetch("https://api.signal.bz/news/realtime", {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`Signal realtime API failed: ${response.status}`);
  }

  const payload = await response.json();
  const source = payload.top20 || payload.top10 || [];

  return source.slice(0, CANDIDATE_LIMIT).map((item, index) => ({
    position: Number(item.rank) || index + 1,
    query: String(item.keyword || "").trim()
  })).filter((item) => item.query);
}

const GOOGLE_RSS_URLS = [
  "https://trends.google.com/trending/rss?geo=KR&hl=ko",
  "https://trends.google.co.kr/trending/rss?geo=KR&hl=ko"
];

async function fetchGoogleTrends() {
  const failures = [];

  for (const url of GOOGLE_RSS_URLS) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "application/rss+xml,text/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9"
        }
      });

      if (!response.ok) {
        failures.push(`${new URL(url).host} ${response.status}`);
        continue;
      }

      const xml = await response.text();
      const rows = parseRssTitles(xml).slice(0, CANDIDATE_LIMIT).map((query, index) => ({
        position: index + 1,
        query
      }));

      if (rows.length) {
        return rows;
      }
      failures.push(`${new URL(url).host} empty`);
    } catch (error) {
      failures.push(`${new URL(url).host} ${error.message || error}`);
    }
  }

  throw new Error(`Google Trends RSS failed: ${failures.join(", ")}`);
}

async function fetchDaumTrends() {
  const response = await fetch("https://www.daum.net/", {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Daum homepage failed: ${response.status}`);
  }

  const html = await response.text();
  return parseDaumKeywords(html);
}

function parseRssTitles(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items
    .map((item) => {
      const match = item.match(/<title>([\s\S]*?)<\/title>/i);
      return match ? decodeXml(match[1]).trim() : "";
    })
    .filter(Boolean);
}

function parseDaumKeywords(html) {
  const start = html.indexOf('"uiType":"REALTIME_TREND_TOP"');
  const source = start >= 0 ? html.slice(start, start + 40000) : html;
  const rows = [];
  const seen = new Set();
  const pattern = /"keyword":"((?:\\.|[^"\\])*)","rank":\d+,"displayRank":(\d+)/g;
  let match;

  while ((match = pattern.exec(source)) && rows.length < CANDIDATE_LIMIT) {
    const query = decodeJsonString(match[1]).trim();
    if (!query || seen.has(query)) continue;

    seen.add(query);
    rows.push({
      position: Number(match[2]) || rows.length + 1,
      query
    });
  }

  return rows;
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch (error) {
    return value;
  }
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function withCors(response) {
  const next = new Response(response.body, response);
  next.headers.set("Access-Control-Allow-Origin", "*");
  return next;
}
