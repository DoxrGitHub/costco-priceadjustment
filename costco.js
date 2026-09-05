/**
 * Costco Price Adjustment Checker — proof of concept
 * ----------------------------------------------------
 * Node 18+ (uses global fetch). Run with: node costco-price-adjustment-checker.js
 *
 * What this does:
 *   1. Pulls your last-30-days warehouse receipts (or reads a cached output.json).
 *   2. Reconstructs what you actually paid per unit for every item, accounting for:
 *        - same-receipt instant discounts/coupons (the "/123456" linker lines)
 *        - price adjustments you already claimed on a LATER, separate receipt
 *          that reference an EARLIER purchase
 *        - best-effort return matching, so returned items aren't flagged
 *   3. Spreads live SKU price checks (against the warehouse each item was bought
 *      at) over ~5-10 minutes so it isn't hammering Costco's servers.
 *   4. Writes a report of what DOES and DOESN'T qualify for a 30-day price
 *      adjustment, with per-lot savings math.
 *
 * Auth: idToken is now refreshed automatically at startup (and persisted
 * back to auth.json) via token-manager.js, using the refresh_token you
 * captured with temp.js. No more hand-pasting a token that dies every
 * ~15 minutes — see token-manager.js for how that works.
 */

const fs = require('fs');
const { getValidIdToken } = require('./token-manager');

// =====================================================================
// CONFIG
// =====================================================================
const CONFIG = {
  // ---- AUTH ----
  // clientID is the app-level Costco-X-Wcs-Clientid header value — it's not
  // a secret and isn't tied to your session, so it's fine hardcoded.
  clientID: '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf',
  // Populated automatically in main() from auth.json via getValidIdToken().
  idToken: null,
  AUTH_FILE: './auth.json',

  // Fallback/home warehouse number. Not sensitive — each lot below still
  // gets checked against whichever warehouse it was ACTUALLY purchased at,
  // this is just used if that's ever missing.
  warehouseId: 113,

  // ---- BUSINESS RULES ----
  ADJUSTMENT_WINDOW_DAYS: 30,        // Costco's official price-adjustment window
  EXCLUDE_ITEM_IDENTIFIERS: ['F'],   // 'F' = pharmacy/Rx — excluded from price adjustment
  EXCLUDE_DESCRIPTION_KEYWORDS: ['GAS', 'FUEL'], // gas station purchases are excluded per policy
  ATTEMPT_RETURN_MATCHING: true,     // best-effort: net returns out against a prior lot

  // ---- LIVE PRICE CHECK PACING ----
  TOTAL_RUN_MINUTES: 7,   // spread checks across ~this many minutes (you asked for 5-10)
  MIN_DELAY_MS: 1500,     // floor on the delay between requests no matter how few SKUs exist

  // ---- I/O ----
  USE_CACHED_RECEIPTS: false,   // true = read CACHE_FILE instead of hitting the API
  CACHE_FILE: 'output.json',
  OUTPUT_FILE: 'price-adjustment-report.json',
};

// =====================================================================
// SMALL HELPERS
// =====================================================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function parseLinkerTarget(desc) {
  return (desc || '').replace(/\D/g, '');
}

function isLinkerLine(desc) {
  return !!desc && desc.trim().startsWith('/');
}

function fmt(d) {
  return new Date(d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// =====================================================================
// getReceipts — your finished function, copied over as-is (auth wired to
// CONFIG instead of localStorage, hardcoded fallback token removed).
// =====================================================================
async function getReceipts(startDate, endDate, last30DaysOnly = false) {
  let startStr, endStr;

  if (last30DaysOnly) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30);
    startStr = fmt(start);
    endStr = fmt(end);
  } else {
    startStr = startDate ? fmt(startDate) : fmt(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    endStr = endDate ? fmt(endDate) : fmt(new Date());
  }

  const receiptsQuery = `
    query receipts($startDate: String!, $endDate: String!) {
      receipts(startDate: $startDate, endDate: $endDate) {
        warehouseName documentType transactionDateTime transactionDate companyNumber
        warehouseNumber operatorNumber warehouseShortName registerNumber transactionNumber
        transactionType transactionBarcode total warehouseAddress1 warehouseAddress2
        warehouseCity warehouseState warehouseCountry warehousePostalCode totalItemCount
        subTotal taxes itemArray { itemNumber itemDescription01 frenchItemDescription1
        itemDescription02 frenchItemDescription2 itemIdentifier unit amount taxFlag merchantID
        entryMethod } tenderArray { tenderTypeCode tenderDescription amountTender
        displayAccountNumber sequenceNumber approvalNumber responseCode transactionID
        merchantID entryMethod } couponArray { upcnumberCoupon voidflagCoupon refundflagCoupon
        taxflagCoupon amountCoupon } subTaxes { tax1 tax2 tax3 tax4 aTaxPercent aTaxLegend
        aTaxAmount bTaxPercent bTaxLegend bTaxAmount cTaxPercent cTaxLegend cTaxAmount dTaxAmount }
        instantSavings membershipNumber
      }
    }`.replace(/\s+/g, ' ');

  const onlineOrdersQuery = `
    query getOnlineOrders($startDate:String!, $endDate:String!, $pageNumber:Int, $pageSize:Int, $warehouseNumber:String!) {
      getOnlineOrders(startDate:$startDate, endDate:$endDate, pageNumber:$pageNumber, pageSize:$pageSize, warehouseNumber:$warehouseNumber) {
        pageNumber
        pageSize
        totalNumberOfRecords
        bcOrders {
          orderHeaderId
          orderPlacedDate: orderedDate
          orderNumber: sourceOrderNumber
          orderTotal
          warehouseNumber
          status
          emailAddress
          orderCancelAllowed
          orderPaymentFailed: orderPaymentEditAllowed
          orderReturnAllowed
          orderLineItems {
            orderLineItemCancelAllowed
            orderLineItemId
            orderReturnAllowed
            itemId
            itemNumber
            itemTypeId
            lineNumber
            itemDescription
            deliveryDate
            warehouseNumber
            status
            orderStatus
            parentOrderLineItemId
            isFSAEligible
            shippingType
            shippingTimeFrame
            isShipToWarehouse
            carrierItemCategory
            carrierContactPhone
            programTypeId
            isBuyAgainEligible
            scheduledDeliveryDate
            scheduledDeliveryDateEnd
            configuredItemData
            shipment {
              shipmentId
              orderHeaderId
              orderShipToId
              lineNumber
              orderNumber
              shippingType
              shippingTimeFrame
              shippedDate
              packageNumber
              trackingNumber
              trackingSiteUrl
              carrierName
              estimatedArrivalDate
              deliveredDate
              isDeliveryDelayed
              isEstimatedArrivalDateEligible
              statusTypeId
              status
              pickUpReadyDate
              pickUpCompletedDate
              reasonCode
              trackingEvent {
                event
                carrierName
                eventDate
                estimatedDeliveryDate
                scheduledDeliveryDate
                trackingNumber
              }
            }
          }
        }
      }
    }`.replace(/\s+/g, ' ');

  const headers = {
    'Content-Type': 'application/json-patch+json',
    'Costco.Env': 'ecom',
    'Costco.Service': 'restOrders',
    'Costco-X-Wcs-Clientid': CONFIG.clientID,
    'Client-Identifier': '481b1aec-aa3b-454b-b81b-48187e28f205',
    'Costco-X-Authorization': 'Bearer ' + (CONFIG.idToken || ''),
  };

  const endpoint = 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';

  const [warehouseRes, onlineRes] = await Promise.all([
    fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: receiptsQuery, variables: { startDate: startStr, endDate: endStr } }),
    }),
    fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: onlineOrdersQuery,
        variables: { startDate: startStr, endDate: endStr, pageNumber: 1, pageSize: 100, warehouseNumber: String(CONFIG.warehouseId) },
      }),
    }),
  ]);

  if (!warehouseRes.ok) throw new Error(`Warehouse GraphQL request failed: ${warehouseRes.status}`);
  if (!onlineRes.ok) throw new Error(`Online GraphQL request failed: ${onlineRes.status}`);

  const warehouseJson = await warehouseRes.json();
  const onlineJson = await onlineRes.json();

  const rawReceipts = warehouseJson.data?.receipts || [];
  const rawOnlinePages = onlineJson.data?.getOnlineOrders || [];
  const rawOnlineOrders = rawOnlinePages.flatMap((page) => page.bcOrders || []);

  const cleanWarehouseReceipts = rawReceipts.filter((receipt) => {
    const isOnlineGhost =
      receipt.documentType?.toLowerCase().includes('online') ||
      receipt.warehouseName?.toLowerCase().includes('costco.com') ||
      receipt.warehouseName?.toLowerCase().includes('ecom') ||
      receipt.registerNumber === 99 ||
      receipt.registerNumber === '99';
    return !isOnlineGhost;
  });

  // DEBUG / cache, same idea as your original script
  fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify({ warehouse: cleanWarehouseReceipts, online: rawOnlineOrders }, null, 2));

  return { warehouse: cleanWarehouseReceipts, online: rawOnlineOrders };
}

// =====================================================================
// searchItemPrice — generalized version of your thisishowtosearchanitem()
// demo. No auth headers needed for this endpoint (matches your sample).
// =====================================================================
async function searchItemPrice(itemNumber, warehouseId) {
  const headers = {
    'User-Agent': 'device/Android',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  };

  const body = {
    type: 'com.costco.app.core.model.network.BffIOHRequest',
    currentWarehouse: String(warehouseId),
    selectedWarehouse: String(warehouseId),
    searchTerm: String(itemNumber),
    maxWhCount: '10',
    sortField: 'lastWeek',
    sortDirection: 'desc',
    locale: 'en_US',
    relevance: 80,
    validMember: true,
  };

  const res = await fetch('https://gdx-api-mobileapps.costco.com/consumer-mobile/core/warehouse-mode/v1/mobile/whmodebffservice/items', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Item search failed for ${itemNumber}: ${res.status} ${res.statusText}`);

  const json = await res.json();
  const items = json.items || [];
  const match = items.find((i) => String(i.itemNumber) === String(itemNumber)) || items[0];
  if (!match) return null;

  return {
    itemNumber: match.itemNumber,
    description: match.itemDescription,
    currentPrice: match.sellPrice != null ? parseFloat(match.sellPrice) : null,
    originalShelfPrice: match.originalSellPrice != null ? parseFloat(match.originalSellPrice) : null,
    activeTpdAmount: match.activeTpdAmount != null ? parseFloat(match.activeTpdAmount) : 0,
    activeTpdEndDate: match.activeTpdEndDate || null,
    inventoryStatus: match.inventoryStatus || null,
  };
}

// =====================================================================
// cleanReciepts — your unfinished function, fully implemented.
//
// Turns the raw warehouse receipt array into "lots" (one purchase event
// of N units of an item, at an effective per-unit price) plus:
//   - unresolvedAdjustments: adjustment linkers whose original purchase
//     wasn't found anywhere in the fetched window
//   - returns: negative/zero-unit lines that look like a refund
//
// Handles:
//   - same-receipt linker lines ("/1013100") -> merged into the item's
//     price on the spot, does NOT count as a used price-adjustment claim
//   - cross-receipt linker lines (its own standalone receipt, referencing
//     an item bought earlier) -> resolved against prior lots FIFO, DOES
//     count as a used price-adjustment claim (one-time, matches Costco's
//     actual policy and your "adam" example)
// =====================================================================
function cleanReciepts(reciepts, isWarehouse) {
  if (!isWarehouse) {
    throw new Error('cleanReciepts: online orders are not supported in this POC yet.');
  }

  // Oldest first, so cross-receipt adjustments can find the lot they refer to.
  const sorted = [...reciepts].sort((a, b) => new Date(a.transactionDateTime) - new Date(b.transactionDateTime));

  const lots = [];
  const returns = [];
  const pendingCrossReceiptLinkers = [];

  for (const receipt of sorted) {
    const rawItems = receipt.itemArray || [];
    const receiptId = receipt.transactionBarcode || `${receipt.warehouseNumber}-${receipt.registerNumber}-${receipt.transactionNumber}`;

    const lines = rawItems.map((raw) => {
      const desc = (raw.itemDescription01 || '').trim();
      return {
        itemNumber: String(raw.itemNumber),
        description: `${raw.itemDescription01 || ''} ${raw.itemDescription02 || ''}`.trim(),
        unit: raw.unit,
        amount: raw.amount,
        taxFlag: raw.taxFlag,
        itemIdentifier: raw.itemIdentifier,
        isLinker: isLinkerLine(desc),
        linkerTarget: isLinkerLine(desc) ? parseLinkerTarget(desc) : null,
        instantDiscountTotal: 0,
      };
    });

    // Pass 1: merge same-receipt linkers into the nearest preceding matching item.
    const consumedLinkerIdx = new Set();
    lines.forEach((line, i) => {
      if (!line.isLinker) return;
      for (let j = i - 1; j >= 0; j--) {
        const target = lines[j];
        if (!target.isLinker && target.itemNumber === line.linkerTarget) {
          target.amount = round2(target.amount + line.amount); // line.amount is negative
          target.instantDiscountTotal = round2(target.instantDiscountTotal + Math.abs(line.amount));
          consumedLinkerIdx.add(i);
          break;
        }
      }
    });

    // Pass 2: leftover linkers reference a purchase on a DIFFERENT receipt.
    lines.forEach((line, i) => {
      if (!line.isLinker || consumedLinkerIdx.has(i)) return;
      pendingCrossReceiptLinkers.push({
        refItemNumber: line.linkerTarget,
        unit: line.unit, // negative
        amount: line.amount, // negative
        receiptDate: receipt.transactionDate,
        receiptId,
      });
    });

    // Pass 3: returns and genuine purchase lines become lots.
    lines.forEach((line) => {
      if (line.isLinker) return;

      if (line.unit <= 0) {
        returns.push({
          itemNumber: line.itemNumber,
          description: line.description,
          unit: line.unit,
          amount: line.amount,
          receiptDate: receipt.transactionDate,
          receiptId,
        });
        return;
      }

      lots.push({
        itemNumber: line.itemNumber,
        description: line.description,
        warehouseNumber: receipt.warehouseNumber,
        purchaseDate: receipt.transactionDate,
        receiptId,
        unitsTotal: line.unit,
        unitsReturned: 0,
        unitsAdjusted: 0,
        unitsRemaining: line.unit,
        originalUnitPrice: round2(line.amount / line.unit), // effective price paid, post same-receipt discount
        instantDiscountPerUnit: round2(line.instantDiscountTotal / line.unit),
        adjustments: [],
        itemIdentifier: line.itemIdentifier,
        taxFlag: line.taxFlag,
      });
    });
  }

  // Best-effort return matching: net a return against the newest matching
  // unreturned/unadjusted lot dated on or before the return.
  if (CONFIG.ATTEMPT_RETURN_MATCHING) {
    for (const ret of returns) {
      const candidates = lots
        .filter((l) => l.itemNumber === ret.itemNumber && l.unitsRemaining > 0 && new Date(l.purchaseDate) <= new Date(ret.receiptDate))
        .sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate)); // newest first

      // We usually don't know exact returned quantity (unit is often 0), so
      // guess it from the dollar amount vs. the lot's per-unit price.
      let guessedUnits = ret.unit > 0 ? ret.unit : null;
      const match = candidates[0];
      if (match) {
        if (guessedUnits == null && match.originalUnitPrice > 0) {
          guessedUnits = Math.min(match.unitsRemaining, Math.max(1, Math.round(Math.abs(ret.amount) / match.originalUnitPrice)));
        }
        if (guessedUnits) {
          const take = Math.min(guessedUnits, match.unitsRemaining);
          match.unitsReturned += take;
          match.unitsRemaining -= take;
          ret.matchedLotReceiptId = match.receiptId;
          ret.matchConfidence = ret.unit > 0 ? 'exact' : 'guessed-from-amount';
          ret.unitsNetted = take;
        }
      }
    }
  }

  // Resolve cross-receipt adjustment linkers, oldest linker first, FIFO
  // against the oldest unadjusted lot of the same item purchased earlier.
  const unresolvedAdjustments = [];
  const sortedLinkers = pendingCrossReceiptLinkers.sort((a, b) => new Date(a.receiptDate) - new Date(b.receiptDate));

  for (const adj of sortedLinkers) {
    let unitsToConsume = Math.abs(adj.unit);
    const discountPerUnit = unitsToConsume > 0 ? Math.abs(adj.amount) / unitsToConsume : 0;

    const candidates = lots
      .filter((l) => l.itemNumber === adj.refItemNumber && l.unitsRemaining > 0 && new Date(l.purchaseDate) <= new Date(adj.receiptDate))
      .sort((a, b) => new Date(a.purchaseDate) - new Date(b.purchaseDate)); // oldest first (FIFO)

    for (const lot of candidates) {
      if (unitsToConsume <= 0) break;
      const take = Math.min(unitsToConsume, lot.unitsRemaining);
      const newUnitPrice = round2(lot.originalUnitPrice - discountPerUnit);

      if (take < lot.unitsRemaining) {
        // Split: only part of this lot got adjusted, the rest is still fully eligible.
        lots.push({
          ...lot,
          unitsTotal: take,
          unitsReturned: 0,
          unitsAdjusted: take,
          unitsRemaining: 0,
          adjustments: [{ date: adj.receiptDate, units: take, newUnitPrice, discountPerUnit: round2(discountPerUnit), viaReceiptId: adj.receiptId }],
        });
        lot.unitsTotal -= take;
        lot.unitsRemaining -= take;
      } else {
        lot.unitsAdjusted += take;
        lot.unitsRemaining -= take;
        lot.adjustments.push({ date: adj.receiptDate, units: take, newUnitPrice, discountPerUnit: round2(discountPerUnit), viaReceiptId: adj.receiptId });
      }
      unitsToConsume -= take;
    }

    if (unitsToConsume > 0) {
      unresolvedAdjustments.push({
        ...adj,
        unresolvedUnits: unitsToConsume,
        note: 'Original purchase for this item was not found in the fetched receipt window (likely older than 30 days).',
      });
    }
  }

  return { lots, returns, unresolvedAdjustments };
}

// =====================================================================
// Eligibility math
// =====================================================================
function evaluateLot(lot, currentPrice, today) {
  if (lot.unitsRemaining <= 0) {
    return {
      eligible: false,
      units: 0,
      savingsPerUnit: 0,
      totalSavings: 0,
      reason: lot.unitsAdjusted > 0 ? 'Already claimed a price adjustment for this purchase.' : 'No purchased units left after returns.',
    };
  }

  const daysSincePurchase = Math.floor((today - new Date(lot.purchaseDate)) / 86400000);
  if (daysSincePurchase > CONFIG.ADJUSTMENT_WINDOW_DAYS) {
    return {
      eligible: false,
      units: lot.unitsRemaining,
      savingsPerUnit: 0,
      totalSavings: 0,
      reason: `Purchase is ${daysSincePurchase} days old — outside the ${CONFIG.ADJUSTMENT_WINDOW_DAYS}-day window.`,
    };
  }

  if (currentPrice == null) {
    return {
      eligible: false,
      units: lot.unitsRemaining,
      savingsPerUnit: 0,
      totalSavings: 0,
      reason: 'Current price unavailable (item not found in catalog search).',
    };
  }

  const diff = round2(lot.originalUnitPrice - currentPrice);
  if (diff <= 0) {
    return {
      eligible: false,
      units: lot.unitsRemaining,
      savingsPerUnit: 0,
      totalSavings: 0,
      reason: `Current price ($${currentPrice.toFixed(2)}) is not lower than what you paid ($${lot.originalUnitPrice.toFixed(2)}).`,
    };
  }

  return {
    eligible: true,
    units: lot.unitsRemaining,
    savingsPerUnit: diff,
    totalSavings: round2(diff * lot.unitsRemaining),
    reason: `Price dropped from $${lot.originalUnitPrice.toFixed(2)} to $${currentPrice.toFixed(2)}.`,
  };
}

function isExcluded(lot) {
  if (CONFIG.EXCLUDE_ITEM_IDENTIFIERS.includes(lot.itemIdentifier)) return 'Excluded category (e.g. pharmacy) — not eligible under Costco policy.';
  const descUpper = lot.description.toUpperCase();
  if (CONFIG.EXCLUDE_DESCRIPTION_KEYWORDS.some((kw) => descUpper.includes(kw))) return 'Excluded item type (gas/fuel) — not eligible under Costco policy.';
  return null;
}

// Rolls per-lot eligible entries up by item, since "eligible" has one row
// per PURCHASE (a lot), and the same item bought on 5 different visits
// makes 5 rows. That's the right shape for the JSON (each row ties back to
// a specific receipt), but the wrong shape for "what do I actually go ask
// for" — this collapses it to one row per item with totals across visits.
function groupEligibleBySku(eligible) {
  const map = new Map();
  for (const e of eligible) {
    if (!map.has(e.itemNumber)) {
      map.set(e.itemNumber, {
        itemNumber: e.itemNumber,
        description: e.description,
        currentPrice: e.currentPrice,
        totalUnits: 0,
        totalSavings: 0,
        paidPrices: new Set(),
        purchaseDates: [],
        receiptIds: [],
      });
    }
    const g = map.get(e.itemNumber);
    g.totalUnits += e.units;
    g.totalSavings = round2(g.totalSavings + e.totalSavings);
    g.paidPrices.add(e.originalUnitPrice);
    g.purchaseDates.push(e.purchaseDate);
    g.receiptIds.push(e.receiptId);
  }
  return [...map.values()]
    .map((g) => ({ ...g, paidPrices: [...g.paidPrices].sort((a, b) => a - b), purchaseDates: g.purchaseDates.sort() }))
    .sort((a, b) => b.totalSavings - a.totalSavings);
}

function buildSummary(results) {
  const totalSavings = round2(results.eligible.reduce((sum, e) => sum + e.totalSavings, 0));
  const totalUnits = results.eligible.reduce((sum, e) => sum + e.units, 0);
  return {
    generatedAt: new Date().toISOString(),
    lotsChecked: results.eligible.length + results.notEligible.length,
    uniqueItemsEligible: results.eligibleBySku.length,
    totalUnitsEligible: totalUnits,
    totalPotentialSavings: totalSavings,
    unresolvedAdjustmentCount: results.unresolvedAdjustments.length,
    returnLinesSeen: results.returns.length,
  };
}

function writeReport(results) {
  fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(results, null, 2));
}

function printSummaryTable(results) {
  const rows = (results.eligibleBySku || []).map((g) => ({
    Item: g.description || g.itemNumber,
    SKU: g.itemNumber,
    Paid: g.paidPrices.length > 1 ? g.paidPrices.map((p) => `$${p.toFixed(2)}`).join(' / ') : `$${g.paidPrices[0].toFixed(2)}`,
    Now: `$${g.currentPrice.toFixed(2)}`,
    Units: g.totalUnits,
    Visits: g.purchaseDates.length,
    Savings: `$${g.totalSavings.toFixed(2)}`,
  }));

  if (rows.length) {
    console.table(rows);
    console.log('(One row per item, totaled across every eligible visit. Per-visit/receipt detail is in the JSON report under "eligible".)');
  } else {
    console.log('Nothing currently qualifies for a price adjustment.');
  }
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  if (!CONFIG.USE_CACHED_RECEIPTS) {
    console.log('Checking auth...');
    CONFIG.idToken = await getValidIdToken(CONFIG.AUTH_FILE);
  }

  console.log('Fetching last 30 days of receipts...');
  const raw =
    CONFIG.USE_CACHED_RECEIPTS && fs.existsSync(CONFIG.CACHE_FILE)
      ? JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, 'utf8'))
      : await getReceipts(null, null, true);

  const { lots, returns, unresolvedAdjustments } = cleanReciepts(raw.warehouse, true);
  console.log(`Parsed ${lots.length} purchase lot(s) across ${new Set(lots.map((l) => l.itemNumber)).size} unique item(s).`);
  if (returns.length) console.log(`Saw ${returns.length} return line(s).`);
  if (unresolvedAdjustments.length) console.log(`${unresolvedAdjustments.length} price-adjustment reference(s) point outside the fetched window.`);

  const today = new Date();
  const results = { eligible: [], notEligible: [], unresolvedAdjustments, returns, eligibleBySku: [], summary: null };
  const checkable = [];

  for (const lot of lots) {
    const excludedReason = isExcluded(lot);
    const daysSince = Math.floor((today - new Date(lot.purchaseDate)) / 86400000);

    if (lot.unitsRemaining <= 0) {
      results.notEligible.push({ ...lot, currentPrice: null, ...evaluateLot(lot, null, today) });
    } else if (excludedReason) {
      results.notEligible.push({ ...lot, currentPrice: null, eligible: false, units: lot.unitsRemaining, savingsPerUnit: 0, totalSavings: 0, reason: excludedReason });
    } else if (daysSince > CONFIG.ADJUSTMENT_WINDOW_DAYS) {
      results.notEligible.push({ ...lot, currentPrice: null, ...evaluateLot(lot, null, today) });
    } else {
      checkable.push(lot);
    }
  }

  // Group by (itemNumber, warehouseNumber) so we only hit the API once per SKU/store.
  const pairsMap = new Map();
  for (const lot of checkable) {
    const key = `${lot.itemNumber}::${lot.warehouseNumber}`;
    if (!pairsMap.has(key)) pairsMap.set(key, []);
    pairsMap.get(key).push(lot);
  }
  const pairs = [...pairsMap.entries()];
  console.log(`${pairs.length} unique item/warehouse combo(s) need a live price check.`);

  const totalWindowMs = CONFIG.TOTAL_RUN_MINUTES * 60 * 1000;
  const baseDelay = pairs.length > 0 ? Math.max(CONFIG.MIN_DELAY_MS, totalWindowMs / pairs.length) : 0;

  for (let i = 0; i < pairs.length; i++) {
    const [key, lotsForPair] = pairs[i];
    const [itemNumber, warehouseNumber] = key.split('::');

    process.stdout.write(`[${i + 1}/${pairs.length}] ${itemNumber} @ warehouse ${warehouseNumber}... `);
    let priceInfo = null;
    try {
      priceInfo = await searchItemPrice(itemNumber, warehouseNumber);
    } catch (err) {
      console.log(`error (${err.message})`);
    }
    const currentPrice = priceInfo ? priceInfo.currentPrice : null;
    console.log(currentPrice != null ? `now $${currentPrice.toFixed(2)}` : 'not found in catalog');

    for (const lot of lotsForPair) {
      const evalResult = evaluateLot(lot, currentPrice, today);
      const entry = { ...lot, currentPrice, ...evalResult };
      (evalResult.eligible ? results.eligible : results.notEligible).push(entry);
    }

    results.eligibleBySku = groupEligibleBySku(results.eligible);
    writeReport(results); // persist progress in case this gets interrupted

    if (i < pairs.length - 1) {
      const jitter = baseDelay * (Math.random() * 0.4 - 0.2); // +/-20%
      await sleep(Math.max(CONFIG.MIN_DELAY_MS, baseDelay + jitter));
    }
  }

  results.summary = buildSummary(results);
  writeReport(results);

  console.log('\n--- Eligible for a price adjustment ---');
  printSummaryTable(results);
  console.log(`\nTotal potential savings: $${results.summary.totalPotentialSavings.toFixed(2)}`);
  console.log(`Full report written to ${CONFIG.OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});