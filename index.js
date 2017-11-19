const fs = require('fs');
const fetch = require('isomorphic-fetch');
const cheerio = require('cheerio');
const csv = require('csvtojson');
require('console.table');

if (!fs.existsSync('cache')) {
  fs.mkdirSync('cache');
}

async function fetchMarketCaps({ num, filter, useCache, path, cacheKey }) {
  if (useCache === undefined) {
    useCache = true;
  }
  if (!path) {
    path = '';
  }
  if (!cacheKey) {
    cacheKey = path ? path.replace(/\//g, '-') : '-latest';
  }
  const cacheFile = `cache/marketCaps${cacheKey}.json`;
  if (useCache && fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile));
  }
  const response = await fetch('https://coinmarketcap.com' + path);
  const html = await response.text();
  const $ = cheerio.load(html);
  let totalMarketCap = 0;
  let marketCaps = [];
  $('#currencies tr').each((index, el) => {
    if (index === 0) {
      return;
    }
    const name = $(el)
      .find('.currency-name-container')
      .text();
    const symbol = $(el)
      .find('.currency-symbol')
      .text();
    const marketCap = Number(
      $(el)
        .find('.market-cap')
        .data('usd')
    );
    marketCaps.push({ id: symbol + name, name, symbol, marketCap });
  });

  marketCaps
    .filter(filter)
    .slice(0, num)
    .forEach(currency => {
      totalMarketCap += currency.marketCap;
    });
  marketCaps
    .filter(filter)
    .slice(0, num)
    .forEach(currency => {
      currency.targetAllocation = currency.marketCap / totalMarketCap;
    });
  fs.writeFileSync(cacheFile, JSON.stringify({ marketCaps, totalMarketCap }));
  return { marketCaps, totalMarketCap };
}

async function fetchHistoricalData({ num, filter }) {
  const response = await fetch('https://coinmarketcap.com/historical/');
  const html = await response.text();
  const $ = cheerio.load(html);
  const fetches = [];
  const data = {};
  $('li.text-center a').each((index, el) => {
    const call = async () => {
      const href = $(el).attr('href');
      if (href.indexOf('/') > -1 && href.split('/')[2].indexOf('2017') > -1) {
        console.log('fetching', href);
        data[href.split('/')[2]] = await fetchMarketCaps({
          num,
          filter,
          path: href,
        });
      }
    };
    fetches.push(call());
  });
  await Promise.all(fetches);
  return data;
}

function parseCSV(csvFilePath) {
  return new Promise((resolve, reject) => {
    const records = [];
    csv()
      .fromFile(csvFilePath)
      .on('json', jsonObj => {
        records.push(jsonObj);
      })
      .on('done', error => {
        if (error) {
          reject(error);
        } else {
          resolve(records);
        }
      });
  });
}

async function fetchCurrentAllocation() {
  const balances = await parseCSV('balances.csv');
  let totalUSD = 0;
  const allocations = balances.map(balance => {
    const usd = Number(
      balance['Value in USD'].split(/\s/)[0].replace(/,/g, '')
    );
    const id = balance['Currency'];
    if (usd > 0) {
      totalUSD += usd;
    }
    return { id, usd };
  });
  const byId = {};
  allocations.forEach(alloc => {
    alloc.currentAllocation = alloc.usd / totalUSD;
    byId[alloc.id] = alloc;
  });
  return { byId, totalUSD };
}

async function calculateTrades({
  num,
  currentAllocations: { byId, totalUSD },
  marketCaps: { marketCaps, totalMarketCap },
}) {
  const trades = marketCaps
    .slice(0, num)
    .filter(({ symbol }) => symbol !== 'BTC')
    .map(({ id, symbol, name, marketCap, targetAllocation }) => {
      const targetUSD = targetAllocation * totalUSD;
      const alloc = byId[id];
      if (!alloc) {
        return {
          symbol,
          name,
          targetAllocation,
          currentAllocation: 0,
          targetUSD,
          currentUSD: 0,
          action: 'BUY',
          amount: targetUSD,
        };
      }
      alloc.processed = true;
      const amount = Math.round(targetUSD - alloc.usd) * 100 / 100;
      return {
        symbol,
        name,
        targetAllocation,
        currentAllocation: alloc.currentAllocation,
        targetUSD,
        currentUSD: alloc.usd,
        action: amount > 0 ? 'BUY' : amount < 0 ? 'SELL' : 'HOLD',
        amount,
      };
    });
  Object.values(byId).forEach(alloc => {
    if (alloc.processed || alloc.usd < 0) {
      return;
    }
    const currency = marketCaps.find(c => c.id === alloc.id);
    trades.push({
      symbol: currency ? currency.symbol : alloc.id,
      name: currency ? currency.name : alloc.id,
      targetAllocation: 0,
      currentAllocation: alloc.currentAllocation,
      targetUSD: 0,
      currentUSD: alloc.usd,
      action: 'SELL',
      amount: alloc.usd,
    });
  });
  return trades;
}

async function simulateTrades({ num, filter, startingAmount }) {
  const historical = await fetchHistoricalData({ num, filter });
  // TODO...
}

async function main() {
  const num = 10;
  const trades = await calculateTrades({
    num,
    currentAllocations: await fetchCurrentAllocation(),
    marketCaps: await fetchMarketCaps({
      num,
      filter: ({ symbol }) => symbol !== 'BTC',
    }),
  });

  console.table(
    trades.map(
      ({
        symbol,
        name,
        targetAllocation,
        currentAllocation,
        targetUSD,
        currentUSD,
        action,
        amount,
      }) => {
        return {
          Symbol: symbol,
          Name: name,
          Action: action,
          Amount: '$' + Math.round(amount * 100) / 100,
          'Target Allocation':
            Math.round(targetAllocation * 10000) / 100 + ' %',
          'Current Allocation':
            Math.round(currentAllocation * 10000) / 100 + ' %',
          'Target USD': '$' + Math.round(targetUSD * 100) / 100,
          'Current USD': '$' + Math.round(currentUSD * 100) / 100,
        };
      }
    )
  );
}

main();
