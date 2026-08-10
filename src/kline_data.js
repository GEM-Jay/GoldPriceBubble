function createEmptyKlineState() {
  return {
    usd: {
      full: [],
      today: [],
      recent: [],
    },
    cny: {
      full: [],
      today: [],
      recent: [],
    },
  };
}

const klineState = createEmptyKlineState();

function resetKlineState() {
  const next = createEmptyKlineState();
  Object.assign(klineState.usd, next.usd);
  Object.assign(klineState.cny, next.cny);
}

function setKlineBucket(market, bucket, data) {
  if (!klineState[market] || !klineState[market][bucket]) return;
  klineState[market][bucket] = Array.isArray(data) ? data : [];
}

function getKlineBucket(market, bucket) {
  return klineState[market]?.[bucket] || [];
}

function getMarketData(market) {
  return klineState[market] || createEmptyKlineState().usd;
}

export {
  getKlineBucket,
  getMarketData,
  klineState,
  resetKlineState,
  setKlineBucket,
};
