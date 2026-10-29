const CACHE_SECONDS = 600;
const TREND_LIMIT = 10;
const CACHE_VERSION = "v7-youtube";

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

  let youtubeError = "";
  const [naver, google, daum, youtube] = await Promise.all([
    safeFetch(fetchNaverTrends),
    safeFetch(fetchGoogleTrends),
    safeFetch(fetchDaumTrends),
    fetchYouTubeTrends(env.YOUTUBE_API_KEY).catch((error) => {
      youtubeError = String(error.message || error);
      return [];
    })
  ]);

  const response = jsonResponse({
    updatedAt: new Date().toISOString(),
    data: { naver, google, daum, youtube },
    ...(youtubeError ? { youtubeError } : {})
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
  const source = payload.top20 || payload.top10 || [];

  return source.slice(0, TREND_LIMIT).map((item, index) => ({
    position: Number(item.rank) || index + 1,
    query: String(item.keyword || "").trim()
  })).filter((item) => item.query);
}

async function fetchGoogleTrends() {
  const daily = await safeGoogleDailyTrends();
  if (daily.length) {
    return daily;
  }

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
  return parseRssTitles(xml).slice(0, TREND_LIMIT).map((query, index) => ({
    position: index + 1,
    query
  }));
}

async function safeGoogleDailyTrends() {
  try {
    const url = "https://trends.google.com/trends/api/dailytrends?hl=ko&tz=-540&geo=KR&ns=15";
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*"
      }
    });

    if (!response.ok) {
      return [];
    }

    const text = await response.text();
    const jsonText = text.replace(/^\)\]\}',?\s*/, "");
    const payload = JSON.parse(jsonText);
    const items = payload?.default?.trendingSearchesDays?.[0]?.trendingSearches || [];

    return items.slice(0, TREND_LIMIT).map((item, index) => ({
      position: index + 1,
      query: String(item?.title?.query || "").trim()
    })).filter((item) => item.query);
  } catch (error) {
    return [];
  }
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

async function fetchYouTubeTrends(apiKey) {
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY is not set");
  }

  const params = new URLSearchParams({
    part: "snippet",
    chart: "mostPopular",
    regionCode: "KR",
    maxResults: String(TREND_LIMIT),
    key: apiKey
  });
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
    throw new Error(`YouTube API failed: ${response.status} ${reason}`.trim());
  }

  const payload = await response.json();
  return (payload.items || []).slice(0, TREND_LIMIT).map((item, index) => ({
    position: index + 1,
    query: String(item?.snippet?.title || "").trim(),
    channel: String(item?.snippet?.channelTitle || "").trim(),
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(item?.id || "")}`
  })).filter((item) => item.query && item.url.length > 32);
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
