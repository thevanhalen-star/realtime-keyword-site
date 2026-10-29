const CACHE_SECONDS = 600;
const RETRY_CACHE_SECONDS = 60;
const TREND_LIMIT = 10;
const CACHE_VERSION = "v11-top10";

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname === "/api/trends") {
      return handleTrends(request, env, context);
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
  const [naver, google, daum] = await Promise.all([
    safeFetch("naver", fetchNaverTrends, errors),
    safeFetch("google", fetchGoogleTrends, errors),
    safeFetch("daum", fetchDaumTrends, errors)
  ]);

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
  return withCors(response);
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

  return source.slice(0, TREND_LIMIT).map((item, index) => ({
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
      const rows = parseRssTitles(xml).slice(0, TREND_LIMIT).map((query, index) => ({
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

  while ((match = pattern.exec(source)) && rows.length < TREND_LIMIT) {
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
