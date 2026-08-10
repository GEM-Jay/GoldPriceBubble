import { COS_CDN } from './config.js';
import { getKlineBucket, getMarketData, resetKlineState, setKlineBucket } from './kline_data.js';
import { once } from './runtime.js';

const FULL_KEEP_BARS = 2200;
const CACHE_VERSION = 'v3';
const TTL = {
  today: 15 * 60 * 1000,
  recent: 60 * 60 * 1000,
  full: 24 * 60 * 60 * 1000,
};

const _cache = {
  usd: _emptyMarket(),
  cny: _emptyMarket(),
};
const _inflight = new Map();
let _httpFetch = null;
let _log = async () => {};

function setLogger(logger) {
  _log = typeof logger === 'function' ? logger : async () => {};
}

function setHttpFetch(httpFetch) {
  _httpFetch = httpFetch || null;
}

function _emptyBucket() {
  return {
    fetchedAt: 0,
    data: [],
  };
}

function _emptyMarket() {
  return {
    full: _emptyBucket(),
    today: _emptyBucket(),
    recent: _emptyBucket(),
  };
}

function _cdn() {
  return String(COS_CDN || '').replace(/\/$/, '');
}

function _storageKey(market, bucket) {
  return `kline-cache:${CACHE_VERSION}:${market}:${bucket}`;
}

function _trimFull(data) {
  return data.length > FULL_KEEP_BARS ? data.slice(data.length - FULL_KEEP_BARS) : data;
}

function _normalizeBars(data) {
  if (!Array.isArray(data)) return [];
  return data.filter((row) => Array.isArray(row) && row.length >= 5 && row[0]);
}

function _bucketForRange(range) {
  if (range === 0) return 'today';
  if (range === 7 || range === 30) return 'recent';
  return 'full';
}

function _persistBucket(market, bucket) {
  try {
    const entry = _cache[market]?.[bucket];
    if (!entry) return;
    localStorage.setItem(_storageKey(market, bucket), JSON.stringify({
      fetchedAt: entry.fetchedAt,
      data: entry.data,
    }));
  } catch (_) {}
}

function _loadBucket(market, bucket) {
  try {
    const raw = localStorage.getItem(_storageKey(market, bucket));
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const data = _normalizeBars(parsed?.data);
    _cache[market][bucket] = {
      fetchedAt: Number(parsed?.fetchedAt) || 0,
      data: bucket === 'full' ? _trimFull(data) : data,
    };
    setKlineBucket(market, bucket, _cache[market][bucket].data);
  } catch (_) {}
}

function _loadPersisted() {
  ['usd', 'cny'].forEach((market) => {
    ['today', 'recent', 'full'].forEach((bucket) => _loadBucket(market, bucket));
  });
}

function _isFresh(market, bucket) {
  const entry = _cache[market]?.[bucket];
  return !!entry && entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < TTL[bucket];
}

async function _get(url, options = {}) {
  try {
    const finalUrl = options.forceRefresh
      ? `${url}${url.includes('?') ? '&' : '?'}_ts=${Date.now()}`
      : url;
    if (_httpFetch) {
      const response = await _httpFetch(finalUrl, { method: 'GET', responseType: 1 });
      return response.ok ? _normalizeBars(response.data ?? []) : [];
    }
    const response = await fetch(finalUrl, { cache: 'no-store' });
    return response.ok ? _normalizeBars(await response.json()) : [];
  } catch (_) {
    return [];
  }
}

function _publishBucket(market, bucket) {
  const data = _cache[market]?.[bucket]?.data || [];
  setKlineBucket(market, bucket, data);
}

function _publishMarket(market) {
  _publishBucket(market, 'full');
  _publishBucket(market, 'today');
  _publishBucket(market, 'recent');
}

async function _loadBucketFromRemote(market, bucket, forceRefresh) {
  const key = `${market}:${bucket}:${forceRefresh ? 'force' : 'ttl'}`;
  if (_inflight.has(key)) return _inflight.get(key);
  const cdn = _cdn();
  if (!cdn) return;
  if (!forceRefresh && _isFresh(market, bucket)) {
    _publishBucket(market, bucket);
    return;
  }

  if (once('kline_cache_remote_fetch_started')) {
    _log('info', 'kline_cache_remote_fetch_started', 'kline cache remote fetch started', {
      market,
      bucket,
      forceRefresh: !!forceRefresh,
    });
  }

  const promise = (async () => {
    const data = await _get(`${cdn}/kline/${market}/${bucket}.json`, { forceRefresh });
    if (data.length) {
      _cache[market][bucket] = {
        fetchedAt: Date.now(),
        data: bucket === 'full' ? _trimFull(data) : data,
      };
      _persistBucket(market, bucket);
    } else if (forceRefresh) {
      await _log('warn', 'kline_cache_remote_fetch_failed', 'kline cache remote fetch failed', {
        market,
        bucket,
        forceRefresh: true,
      });
    }
    _publishBucket(market, bucket);
  })();

  _inflight.set(key, promise);
  try {
    await promise;
  } finally {
    _inflight.delete(key);
  }
}

async function init(options = {}) {
  setHttpFetch(options.httpFetch || null);
  resetKlineState();
  _loadPersisted();
  await _log('info', 'kline_cache_initialized', 'kline cache initialized', {
    markets: ['usd', 'cny'],
  });
}

async function refreshOnView(market, options = {}) {
  if (!market) return;
  const range = options.range ?? 0;
  const bucket = _bucketForRange(range);
  _publishMarket(market);
  if (range === 30) {
    await _loadBucketFromRemote(market, 'full', !!options.forceRefresh);
  }
  await _loadBucketFromRemote(market, bucket, !!options.forceRefresh);
}

function releaseMarket(market) {
  if (!market || !_cache[market]) return;
  _cache[market] = _emptyMarket();
  _publishMarket(market);
}

function pruneExcept(activeMarket) {
  ['usd', 'cny'].forEach((market) => {
    if (market !== activeMarket) releaseMarket(market);
  });
}

function disposeView() {
  resetKlineState();
}

function getStats() {
  return {
    usd: {
      full: _cache.usd.full.data.length,
      today: _cache.usd.today.data.length,
      recent: _cache.usd.recent.data.length,
      fullFetchedAt: _cache.usd.full.fetchedAt,
      todayFetchedAt: _cache.usd.today.fetchedAt,
      recentFetchedAt: _cache.usd.recent.fetchedAt,
    },
    cny: {
      full: _cache.cny.full.data.length,
      today: _cache.cny.today.data.length,
      recent: _cache.cny.recent.data.length,
      fullFetchedAt: _cache.cny.full.fetchedAt,
      todayFetchedAt: _cache.cny.today.fetchedAt,
      recentFetchedAt: _cache.cny.recent.fetchedAt,
    },
  };
}

function getBucketData(market, bucket) {
  return getKlineBucket(market, bucket);
}

const klineCache = {
  init,
  refreshOnView,
  releaseMarket,
  pruneExcept,
  disposeView,
  getStats,
  getMarketData,
  getBucketData,
  setLogger,
  setHttpFetch,
};

export { klineCache };
export default klineCache;
