const CACHE_SECONDS = 600;
const LIVE_LIMIT = 10;
const TREND_LIMIT = 20;
const CACHE_VERSION = "v3-related";

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
  const cacheKey = new Request(`${origin}/api/trends-cache-${CACHE_VERSION}`);
  const cached = await cache.match(cacheKey);

  if (cached) {
    return withCors(cached);
  }

  const [naver, google, daum] = await Promise.all([
    safeFetch(fetchNaverTrends),
    safeFetch(fetchGoogleTrends),
    safeFetch(fetchDaumTrends)
  ]);

  const [naverRows, googleRows, daumRows] = await Promise.all([
    completeWithRelated(naver, fetchNaverRelatedKeywords),
    completeWithRelated(google, fetchGoogleRelatedKeywords),
    completeWithRelated(daum, fetchDaumRelatedKeywords)
  ]);

  const response = jsonResponse({
    updatedAt: new Date().toISOString(),
    data: {
      naver: naverRows,
      google: googleRows,
      daum: daumRows
    }
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

  return source.slice(0, LIVE_LIMIT).map((item, index) => ({
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
  return parseRssTitles(xml).slice(0, LIVE_LIMIT).map((query, index) => ({
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

    return items.slice(0, LIVE_LIMIT).map((item, index) => ({
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

  while ((match = pattern.exec(source)) && rows.length < LIVE_LIMIT) {
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

async function completeWithRelated(rows, relatedFetcher) {
  const baseRows = normalizeTrendRows(rows).slice(0, LIVE_LIMIT);
  const seen = new Set(baseRows.map((item) => normalizeQuery(item.query)));
  const relatedRows = [];

  for (const row of baseRows) {
    if (baseRows.length + relatedRows.length >= TREND_LIMIT) break;

    const related = await safeRelatedFetch(relatedFetcher, row.query);
    for (const query of related) {
      if (baseRows.length + relatedRows.length >= TREND_LIMIT) break;

      const normalized = normalizeQuery(query);
      if (!normalized || seen.has(normalized)) continue;

      seen.add(normalized);
      relatedRows.push({
        query,
        sourceType: "related"
      });
    }
  }

  if (baseRows.length + relatedRows.length < TREND_LIMIT) {
    relatedRows.push(...makeFallbackRelatedRows(baseRows, seen, TREND_LIMIT - baseRows.length - relatedRows.length));
  }

  return normalizeTrendRows([...baseRows, ...relatedRows]).slice(0, TREND_LIMIT);
}

function normalizeTrendRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((item, index) => ({
      position: index + 1,
      query: String(item?.query || "").trim(),
      sourceType: item?.sourceType || (index < LIVE_LIMIT ? "live" : "related")
    }))
    .filter((item) => item.query);
}

async function safeRelatedFetch(fetcher, query) {
  try {
    return await fetcher(query);
  } catch (error) {
    return [];
  }
}

async function fetchNaverRelatedKeywords(query) {
  const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(query)}&st=100&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&ans=2&run=2&rev=4&q_enc=UTF-8`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) return [];

  const payload = await response.json();
  const groups = Array.isArray(payload?.items) ? payload.items : [];
  return groups.flatMap((group) => {
    const values = Array.isArray(group) ? group : [];
    return values.map((item) => Array.isArray(item) ? item[0] : item);
  }).map(cleanSuggestion).filter(Boolean);
}

async function fetchGoogleRelatedKeywords(query) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=KR&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) return [];

  const payload = await response.json();
  return (Array.isArray(payload?.[1]) ? payload[1] : []).map(cleanSuggestion).filter(Boolean);
}

async function fetchDaumRelatedKeywords(query) {
  const url = `https://suggest-bar.daum.net/suggest?mod=json&code=utf_in_out&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) return [];

  const payload = await response.json();
  const items = payload?.items || payload?.suggestions || payload?.[1] || [];

  return flattenValues(items).map((item) => {
    if (typeof item === "string") return item;
    if (Array.isArray(item)) return item[0];
    return item?.keyword || item?.query || item?.value || item?.text || "";
  }).map(cleanSuggestion).filter(Boolean);
}

function makeFallbackRelatedRows(baseRows, seen, count) {
  const suffixes = ["뉴스", "검색", "뜻", "일정", "프로필", "관련주", "논란", "영상", "결과", "정보"];
  const rows = [];

  for (const row of baseRows) {
    for (const suffix of suffixes) {
      if (rows.length >= count) return rows;

      const query = `${row.query} ${suffix}`;
      const normalized = normalizeQuery(query);
      if (!normalized || seen.has(normalized)) continue;

      seen.add(normalized);
      rows.push({
        query,
        sourceType: "related"
      });
    }
  }

  return rows;
}

function cleanSuggestion(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuery(value) {
  return cleanSuggestion(value).toLowerCase();
}

function flattenValues(value) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => Array.isArray(item) ? flattenValues(item) : [item]);
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
