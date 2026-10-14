const CACHE_SECONDS = 600;

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname === "/api/trends") {
      return handleTrends(request, context);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleTrends(request, context) {
  const cache = caches.default;
  const origin = new URL(request.url).origin;
  const cacheKey = new Request(origin + "/api/trends-cache");
  const cached = await cache.match(cacheKey);

  if (cached) {
    return withCors(cached);
  }

  const [naver, google, daum] = await Promise.all([
    safeFetch(fetchNaverTrends),
    safeFetch(fetchGoogleTrends),
    safeFetch(fetchDaumTrends)
  ]);

  const response = jsonResponse({
    updatedAt: new Date().toISOString(),
    data: { naver, google, daum }
  });

  response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response);
}

async function safeFetch(fetcher) {
  try {
    return await fetcher();
  } catch (error) {
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
  return (payload.top10 || []).slice(0, 10).map((item, index) => ({
    position: Number(item.rank) || index + 1,
    query: String(item.keyword || "").trim()
  })).filter((item) => item.query);
}

async function fetchGoogleTrends() {
  const url = "https://trends.google.com/trending/rss?geo=KR";
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/rss+xml,text/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`Google Trends RSS failed: ${response.status}`);
  }

  const xml = await response.text();
  return parseRssTitles(xml).slice(0, 10).map((query, index) => ({
    position: index + 1,
    query
  }));
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

  while ((match = pattern.exec(source)) && rows.length < 10) {
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
