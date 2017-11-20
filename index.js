const fs = require('fs');
const fetch = require('isomorphic-fetch');
const cheerio = require('cheerio');
const csv = require('csvtojson');
const moment = require('moment-mini');
require('console.table');

const CACHE_DIR = __dirname + '/cache';
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

async function fetchMarketCaps({ num, filter, useCache, path, cacheKey }) {
  const USD = {
    id: 'usdusd',
    name: 'USD',
    symbol: 'USD',
    marketCap: 0,
    price: 1,
  };
  if (useCache === undefined) {
    useCache = true;
  }
  if (!path) {
    path = '';
  }
  if (!cacheKey) {
    cacheKey = path ? path.replace(/\//g, '-') : '-latest';
  }
  const cacheFile = `${CACHE_DIR}/marketCaps${cacheKey}.json`;
  if (useCache && fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile));
  }
  const url = 'https://coinmarketcap.com' + path;
  console.log('fetching', url);
  const response = await fetch(url);
  const html = await response.text();
  const $ = cheerio.load(html);
  let marketCaps = [USD];
  let rows = $('#currencies tr');
  if (rows.length === 0) {
    rows = $('#currencies-all tr');
  }
  rows.each((index, el) => {
    if (index === 0) {
      return;
    }
    const name = $(el)
      .find('.currency-name-container')
      .text();
    const price = Number(
      $(el)
        .find('.price')
        .data('usd')
    );
    let symbol = $(el)
      .find('.currency-symbol')
      .text();
    let marketCap = Number(
      $(el)
        .find('.market-cap')
        .data('usd')
    );
    marketCaps.push({
      id: (symbol + name).toLowerCase(),
      name,
      symbol,
      marketCap,
      price,
    });
  });

  fs.writeFileSync(cacheFile, JSON.stringify({ marketCaps }, null, 2));
  return { marketCaps };
}

async function fetchHistoricalData({ num, filter, useCache }) {
  const response = await fetch('https://coinmarketcap.com/historical/');
  const html = await response.text();
  const $ = cheerio.load(html);
  const hrefs = [];
  const fetches = [];
  const data = {};
  $('li.text-center a').each((index, el) => {
    const href = $(el).attr('href');
    if (href.indexOf('/') > -1) {
      const date = href.split('/')[2];
      if (date > '2017') {
        hrefs.push(href);
      }
    }
  });

  for (let href of hrefs) {
    data[href.split('/')[2]] = await fetchMarketCaps({
      num,
      filter,
      path: href,
      useCache,
    });
  }
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

async function fetchCurrentAllocation({ percentInPlay }) {
  const balances = await parseCSV('balances.csv');
  const allocations = balances.map(balance => {
    const coins = Number(balance.Amount) * percentInPlay;
    let id = balance['Currency'].toLowerCase();
    if (id === 'usdus dollar') {
      id = 'usdusd';
    }
    return { id, coins };
  });
  const byId = {};
  allocations.forEach(alloc => {
    if (alloc.id !== 'usdusd') {
      byId[alloc.id] = alloc;
    }
  });
  return byId;
}

async function calculateTrades({
  num,
  byId,
  marketCaps: { marketCaps },
  filter,
  maxAllocation,
}) {
  const marketCapsById = {};
  const sortByMarketCap = (a, b) => b.marketCap - a.marketCap;
  marketCaps.sort(sortByMarketCap);
  let i = 0;
  let totalMarketCap = 0;
  for (let cap of marketCaps) {
    marketCapsById[cap.id] = cap;
    if (filter(cap)) {
      if (i < num) {
        totalMarketCap += cap.marketCap;
      }
      i++;
    }
  }

  const tradeableCoins = marketCaps.filter(filter).slice(0, num);

  if (maxAllocation) {
    overMaxAllocation = true;
    while (overMaxAllocation) {
      overMaxAllocation = false;
      tradeableCoins.forEach(cap => {
        cap.targetAllocation = cap.marketCap / totalMarketCap;
        if (cap.targetAllocation > maxAllocation) {
          overMaxAllocation = true;
          cap.marketCap = totalMarketCap * maxAllocation;
        }
      });
      totalMarketCap = 0;
      tradeableCoins.forEach(({ marketCap }) => {
        totalMarketCap += marketCap;
      });
      tradeableCoins.sort(sortByMarketCap);
    }
  } else {
    tradeableCoins.forEach(cap => {
      cap.targetAllocation = cap.marketCap / totalMarketCap;
    });
  }

  let totalAccountValue = 0;
  Object.values(byId).forEach(alloc => {
    if (alloc.id === 'usdusd') {
      totalAccountValue += alloc.coins;
    } else if (alloc.coins !== 0) {
      const cap = marketCapsById[alloc.id];
      if (!cap) {
        console.error("couldn't find market cap for", alloc.id);
      }
      totalAccountValue += alloc.coins * marketCapsById[alloc.id].price;
    }
  });

  const trades = tradeableCoins.map(
    ({ id, symbol, name, targetAllocation, price }) => {
      const targetUSD = targetAllocation * totalAccountValue;
      const alloc = byId[id];
      if (!alloc) {
        return {
          id: (symbol + name).toLowerCase(),
          symbol,
          name,
          targetAllocation,
          currentAllocation: 0,
          targetCoins: targetUSD / price,
          currentCoins: 0,
          action: targetAllocation > 0 ? 'BUY' : '-',
          price,
        };
      }
      alloc.processed = true;
      const targetCoins = targetUSD / price;
      return {
        id: (symbol + name).toLowerCase(),
        symbol,
        name,
        targetAllocation,
        currentAllocation: alloc.coins * price / totalAccountValue,
        targetCoins,
        currentCoins: alloc.coins,
        action:
          alloc.coins < targetCoins
            ? 'BUY'
            : alloc.coins > targetCoins ? 'SELL' : 'HOLD',
        price,
      };
    }
  );
  Object.values(byId).forEach(alloc => {
    if (alloc.processed) {
      alloc.processed = false;
      return;
    }
    if (alloc.coins === 0) {
      return;
    }
    const currency = marketCapsById[alloc.id];
    if (!currency) {
      console.error('No currency found for', alloc.id);
      throw new Error('I give up');
    }
    const price = currency.price;
    trades.push({
      id: alloc.id,
      symbol: currency ? currency.symbol : alloc.id,
      name: currency ? currency.name : alloc.id,
      targetAllocation: 0,
      currentAllocation: alloc.coins * price / totalAccountValue,
      targetCoins: 0,
      currentCoins: alloc.coins,
      action: 'SELL',
      price,
    });
  });
  return trades;
}

async function simulateTrades({ num, filter, startingAmount, maxAllocation }) {
  const historical = await fetchHistoricalData({
    num,
    filter,
    useCache: true,
  });
  const USD = {
    id: 'usdusd',
    currentAllocation: 1,
    coins: startingAmount,
  };
  const byId = {
    usdusd: USD,
  };
  let totalAccountValue = startingAmount;

  function performTrades(trades) {
    totalAccountValue = 0;
    trades.filter(({ action, symbol }) => action === 'SELL').forEach(trade => {
      if (trade.id === 'usdusd') {
        // selling dollars makes no sense since they are already "sold"
        // so skip them.
        return;
      }
      let alloc = byId[trade.id];
      if (!alloc) {
        console.error('no alloc for', trade);
        throw new Error('no alloc for', trade);
      }
      alloc.coins = trade.targetCoins;
      USD.coins += (trade.currentCoins - trade.targetCoins) * trade.price;
      totalAccountValue += trade.price * alloc.coins;
    });

    trades.filter(({ action }) => action === 'BUY').forEach(trade => {
      let alloc = byId[trade.id];
      if (!alloc) {
        alloc = {
          id: trade.id,
          coins: 0,
        };
        byId[alloc.id] = alloc;
      }
      alloc.coins = trade.targetCoins;
      USD.coins += (trade.currentCoins - trade.targetCoins) * trade.price;
      totalAccountValue += trade.price * alloc.coins;
    });
    trades.filter(({ action }) => action === 'HOLD').forEach(trade => {
      let alloc = byId[trade.id];
      totalAccountValue += trade.price * alloc.coins;
    });
  }

  const dates = Object.keys(historical);
  dates.sort();
  let numTrades = 0;
  let index = -1;
  for (let date of dates) {
    index++;
    if (index % 4 !== 0) {
      continue;
    }
    let trades = await calculateTrades({
      num,
      byId,
      marketCaps: historical[date],
      filter,
      maxAllocation,
    });
    printTrades(trades);
    console.log(date, 'Previous Account Value in USD:', totalAccountValue);
    performTrades(trades);
    numTrades++;
    console.log(date, 'Account Value in USD:', totalAccountValue, '\n\n');
  }
}

function printTrades(trades) {
  console.table(
    trades
      .filter(t => Math.abs(t.targetCoins - t.currentCoins) > 0)
      .map(
        ({
          symbol,
          name,
          targetAllocation,
          currentAllocation,
          targetCoins,
          currentCoins,
          action,
          price,
        }) => {
          return {
            Symbol: symbol,
            Name: name,
            Action: action,
            Amount:
              '$' +
              Math.round((targetCoins - currentCoins) * price * 1000) / 1000,
            'Price / Coin': '$' + price,
            'Target Allocation':
              Math.round(targetAllocation * 100000) / 1000 + ' %',
            'Current Allocation':
              Math.round(currentAllocation * 100000) / 1000 + ' %',
            'Target USD': '$' + Math.round(targetCoins * price * 1000) / 1000,
            'Current USD': '$' + Math.round(currentCoins * price * 1000) / 1000,
            'Target Coins': targetCoins,
            'Current Coins': currentCoins,
          };
        }
      )
  );
}

async function main() {
  const percentInPlay = 0.5;
  const num = 7;
  const maxAllocation = 0.5;
  const blacklist = ['BTC', 'BCH', 'ETC', 'MIOTA', 'USD'];
  const filter = ({ symbol }) => !blacklist.includes(symbol);
  await simulateTrades({ num, filter, startingAmount: 100, maxAllocation });
  //return;
  const trades = await calculateTrades({
    num,
    byId: await fetchCurrentAllocation({ percentInPlay }),
    marketCaps: await fetchMarketCaps({
      num,
      filter,
    }),
    filter,
    maxAllocation,
  });
  printTrades(trades);
}

main();
