#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          LÉO FINANCE OS — SYNC ENGINE v2.0                  ║
 * ║  Shopify · Google Ads · Klaviyo → leo-sync-data.js          ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node sync.js                          → hier (auto)
 *   node sync.js 2026-04-05               → date spécifique
 *   node sync.js --range 2026-03-01 2026-04-05  → plage de dates
 *   node sync.js --full-sync              → TOUTES les données historiques
 *
 * Champs automatiques:
 *   ✅ CA Brut          (Shopify Orders)
 *   ✅ Retours          (Shopify Refunds)
 *   ✅ CA Email         (Klaviyo Revenue Attribution)
 *   ✅ Commandes        (Shopify Orders count)
 *   ✅ Nouveaux clients (Shopify Customers)
 *   ✅ Clients récurr.  (Shopify Customers history)
 *
 * Champs MANUELS (non synchronisés):
 *   ✋ Coût Fournisseur
 *   ✋ Frais livraison
 *   ✋ Frais Shopify (abonnement)
 *   ✋ Autres frais
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE  = join(__dir, 'config.json');
const OUTPUT_FILE  = join(__dir, '..', 'leo-sync-data.js');

// ── COULEURS CONSOLE ──────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', white: '\x1b[97m',
};
const log   = (e, m) => console.log(`${e}  ${m}`);
const ok    = (m)    => console.log(`${C.green}  ✓${C.reset}  ${m}`);
const warn  = (m)    => console.log(`${C.yellow}  ⚠${C.reset}  ${m}`);
const fail  = (m)    => console.log(`${C.red}  ✗${C.reset}  ${m}`);
const sep   = ()     => console.log(`${C.dim}${'─'.repeat(56)}${C.reset}`);

// ── UTILS ─────────────────────────────────────────────────────────────────────
function getISOWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function dateRange(from, to) {
  const dates = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── GOOGLE OAUTH ───────────────────────────────────────────────────────────────
async function refreshGoogleToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── SHOPIFY HELPERS ────────────────────────────────────────────────────────────
async function shopifyGet(shop, token, endpoint, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const url = `https://${shop}/admin/api/2024-04/${endpoint}${qs}`;
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  if (res.status === 429) {
    warn('Shopify rate limit — retry in 2s');
    await sleep(2000);
    return shopifyGet(shop, token, endpoint, params);
  }
  if (!res.ok) throw new Error(`Shopify /${endpoint}: HTTP ${res.status}`);
  return res.json();
}

// ── SHOPIFY : sync journalier (mode normal) ────────────────────────────────────
async function syncShopify(cfg, dateStr) {
  const { shop, token } = cfg;
  const start = `${dateStr}T00:00:00+00:00`;
  const end   = `${dateStr}T23:59:59+00:00`;

  let allOrders = [];
  let params = {
    status: 'any',
    created_at_min: start,
    created_at_max: end,
    limit: 250,
    fields: 'id,total_price,financial_status,customer,refunds,total_shipping_price_set,gateway',
  };

  for (let page = 0; page < 4; page++) {
    const data = await shopifyGet(shop, token, 'orders.json', params);
    const orders = data.orders || [];
    allOrders = allOrders.concat(orders);
    if (orders.length < 250) break;
    params = { ...params, since_id: orders[orders.length - 1].id };
    delete params.created_at_min; delete params.created_at_max;
  }

  const ca = allOrders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const commandes = allOrders.length;

  let retours = 0;
  allOrders.forEach(o => {
    (o.refunds || []).forEach(r => {
      (r.transactions || []).forEach(t => {
        if (['refund', 'void'].includes(t.kind)) retours += parseFloat(t.amount || 0);
      });
    });
  });

  let nouveaux = 0, recurrents = 0;
  const checked = new Set();
  for (const o of allOrders) {
    const cid = o.customer?.id;
    if (!cid) { nouveaux++; continue; }
    if (checked.has(cid)) { recurrents++; continue; }
    checked.add(cid);
    try {
      const { customer } = await shopifyGet(shop, token, `customers/${cid}.json`);
      if ((customer?.orders_count || 0) > 1) recurrents++;
      else nouveaux++;
    } catch { nouveaux++; }
    await sleep(100);
  }

  return {
    ca:                 Math.round(ca       * 100) / 100,
    commandes,
    retours:            Math.round(retours  * 100) / 100,
    nouveaux_clients:   nouveaux,
    clients_recurrents: recurrents,
  };
}

// ── SHOPIFY : full sync historique ─────────────────────────────────────────────
async function fullSyncShopify(cfg) {
  const { shop, token } = cfg;
  log('🔄', `Full sync Shopify — récupération de toutes les commandes : ${shop}`);

  let allOrders = [];
  // Pagination via since_id — plus fiable que le curseur Link
  let sinceId = 0;
  let page = 0;

  while (true) {
    page++;
    const params = {
      status:          'any',
      limit:           250,
      fields:          'id,total_price,customer,refunds,created_at',
      created_at_min:  '2018-01-01T00:00:00Z',
      since_id:        sinceId,
    };

    let res;
    while (true) {
      res = await fetch(
        `https://${shop}/admin/api/2024-04/orders.json?` + new URLSearchParams(params),
        { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
      );
      if (res.status === 429) { warn('Rate limit Shopify, attente 2s...'); await sleep(2000); continue; }
      break;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Shopify orders full sync: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const orders = data.orders || [];
    allOrders = allOrders.concat(orders);

    if (page % 4 === 0 || orders.length < 250) log('📦', `${allOrders.length} commandes récupérées...`);

    // Arrêt si dernière page
    if (orders.length < 250) break;

    // Prochain batch à partir du dernier ID
    sinceId = orders[orders.length - 1].id;
    await sleep(300);
  }

  ok(`${allOrders.length} commandes totales récupérées`);

  // Trier chronologiquement pour déterminer nouveaux vs récurrents
  allOrders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const customerSeen = new Set();
  const weeklyData   = {};

  for (const order of allOrders) {
    const dateStr = order.created_at.split('T')[0];
    const weekKey = getISOWeekKey(dateStr);

    if (!weeklyData[weekKey]) {
      weeklyData[weekKey] = { ca: 0, commandes: 0, retours: 0, nouveaux_clients: 0, clients_recurrents: 0 };
    }
    const w = weeklyData[weekKey];

    w.ca += parseFloat(order.total_price || 0);
    w.commandes++;

    // Retours
    (order.refunds || []).forEach(r => {
      (r.transactions || []).forEach(t => {
        if (['refund', 'void'].includes(t.kind)) {
          w.retours += parseFloat(t.amount || 0);
        }
      });
    });

    // Nouveau vs récurrent (basé sur l'historique des commandes du dataset)
    const cid = order.customer?.id;
    if (!cid || !customerSeen.has(cid)) {
      w.nouveaux_clients++;
      if (cid) customerSeen.add(cid);
    } else {
      w.clients_recurrents++;
    }
  }

  // Arrondi
  for (const w of Object.values(weeklyData)) {
    w.ca      = Math.round(w.ca      * 100) / 100;
    w.retours = Math.round(w.retours * 100) / 100;
  }

  return weeklyData;
}

// ── KLAVIYO HELPERS ───────────────────────────────────────────────────────────
async function klaviyoPost(apiKey, endpoint, body) {
  const res = await fetch(`https://a.klaviyo.com/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${apiKey}`,
      'revision': '2024-02-15',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Klaviyo /${endpoint}: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function klaviyoGet(apiKey, endpoint, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const res = await fetch(`https://a.klaviyo.com/api/${endpoint}${qs}`, {
    headers: {
      'Authorization': `Klaviyo-API-Key ${apiKey}`,
      'revision': '2024-02-15',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Klaviyo /${endpoint}: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getKlaviyoMetricId(apiKey) {
  const metrics = await klaviyoGet(apiKey, 'metrics', {});
  const metric  = metrics.data?.find(m =>
    m.attributes?.name?.toLowerCase().includes('placed order') ||
    m.attributes?.name?.toLowerCase().includes('order placed')
  );
  if (!metric) {
    const names = metrics.data?.map(m => m.attributes?.name).join(', ') || 'aucun';
    warn(`Klaviyo: metric "Placed Order" introuvable. Metrics dispo: ${names}`);
    return null;
  }
  ok(`Klaviyo: metric → "${metric.attributes.name}" (${metric.id})`);
  return metric.id;
}

// ── KLAVIYO : sync journalier (mode normal) ───────────────────────────────────
async function syncKlaviyo(cfg, dateStr) {
  const { api_key } = cfg;
  const metricId = await getKlaviyoMetricId(api_key);
  if (!metricId) return { ca_email: 0 };

  const start   = `${dateStr}T00:00:00+00:00`;
  const nextDay = new Date(dateStr + 'T12:00:00Z');
  nextDay.setDate(nextDay.getDate() + 1);
  const end = nextDay.toISOString().split('T')[0] + 'T00:00:00+00:00';

  const data = await klaviyoPost(api_key, 'metric-aggregates/', {
    data: {
      type: 'metric-aggregate',
      attributes: {
        metric_id:    metricId,
        interval:     'day',
        measurements: ['sum_value'],
        filter:       `greater-or-equal(datetime,${start}),less-than(datetime,${end})`,
        by:           ['$attributed_channel'],
      },
    },
  });

  const results = data.data?.attributes?.data || [];  // Klaviyo retourne "data", pas "results"
  // Cherche le channel "email" dans les résultats groupés par $attributed_channel
  const emailRow = results.find(r => (r.dimensions?.[0] || '').toLowerCase().includes('email'));
  const ca_email = parseFloat(emailRow?.measurements?.sum_value?.[0] || 0);

  return { ca_email: Math.round(ca_email * 100) / 100 };
}

// ── KLAVIYO : full sync historique ────────────────────────────────────────────
async function fullSyncKlaviyo(cfg, startDate = '2022-01-01') {
  const { api_key } = cfg;
  const metricId = await getKlaviyoMetricId(api_key);
  if (!metricId) return {};

  // Klaviyo max range = 1 an → on découpe en tranches annuelles
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const endDate = tomorrow.toISOString().split('T')[0];

  // Génère les tranches [start, end] d'au plus 1 an
  const slices = [];
  let cursor = new Date(startDate);
  const finalEnd = new Date(endDate);
  while (cursor < finalEnd) {
    const sliceEnd = new Date(cursor);
    sliceEnd.setFullYear(sliceEnd.getFullYear() + 1);
    if (sliceEnd > finalEnd) sliceEnd.setTime(finalEnd.getTime());
    slices.push([
      cursor.toISOString().split('T')[0],
      sliceEnd.toISOString().split('T')[0],
    ]);
    cursor = new Date(sliceEnd);
  }

  log('🔄', `Klaviyo: récupération du CA email (${slices.length} tranche(s) annuelle(s))...`);

  const weeklyData = {};

  for (const [sliceStart, sliceEnd] of slices) {
    await new Promise(r => setTimeout(r, 1200)); // rate limit Klaviyo
    const data = await klaviyoPost(api_key, 'metric-aggregates/', {
      data: {
        type: 'metric-aggregate',
        attributes: {
          metric_id:    metricId,
          interval:     'day',
          measurements: ['sum_value'],
          filter:       `greater-or-equal(datetime,${sliceStart}T00:00:00+00:00),less-than(datetime,${sliceEnd}T00:00:00+00:00)`,
          by:           ['$attributed_channel'],
        },
      },
    });

    const dates   = data.data?.attributes?.dates || [];
    const results = data.data?.attributes?.data  || [];  // Klaviyo retourne "data", pas "results"

    for (const r of results) {
      const channel = (r.dimensions?.[0] || '').toLowerCase();
      // Garde uniquement Email (exclut SMS, Push, Direct, etc.)
      if (!channel.includes('email')) continue;
      const values = r.measurements?.sum_value || [];
      values.forEach((val, i) => {
        if (!val || !dates[i]) return;
        const dateStr = dates[i].split('T')[0];
        const weekKey = getISOWeekKey(dateStr);
        if (!weeklyData[weekKey]) weeklyData[weekKey] = { ca_email: 0 };
        weeklyData[weekKey].ca_email += parseFloat(val || 0);
      });
    }
  }

  // Arrondi
  for (const w of Object.values(weeklyData)) {
    w.ca_email = Math.round(w.ca_email * 100) / 100;
  }

  ok(`Klaviyo: ${Object.keys(weeklyData).length} semaines avec CA email`);
  return weeklyData;
}

// ── GOOGLE ADS via leo-ads-data.json (écrit par le Google Ads Script) ─────────
function loadGoogleAdsData() {
  try {
    const filePath = join(dirname(new URL(import.meta.url).pathname), '..', 'leo-ads-data.json');
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    warn(`Google Ads: impossible de lire leo-ads-data.json — ${e.message}`);
    return {};
  }
}

// ── AGGREGATE: day → week ──────────────────────────────────────────────────────
const NUMERIC_FIELDS = [
  'ca', 'retours', 'ca_email',
  'commandes', 'nouveaux_clients', 'clients_recurrents',
  'ads', 'impressions', 'clics',
];

const MANUAL_FIELDS = ['fournisseur', 'livraison', 'shopify', 'autres'];

function mergeDayIntoWeek(weekData, dayResult) {
  const updated = { ...weekData };
  for (const field of NUMERIC_FIELDS) {
    if (dayResult[field] != null) {
      updated[field] = Math.round(((parseFloat(updated[field] || 0)) + dayResult[field]) * 100) / 100;
    }
  }
  return updated;
}

// ── SYNC JOURNALIER ────────────────────────────────────────────────────────────
async function syncDate(dateStr, config, existingData) {
  const weekKey = getISOWeekKey(dateStr);
  console.log(`\n${C.bold}${C.cyan}  📅 ${dateStr}  →  ${weekKey}${C.reset}`);
  sep();

  const results = {};

  let googleToken = null;
  if (config.google?.refresh_token && !config.google.refresh_token.includes('XXX')) {
    try {
      googleToken = await refreshGoogleToken(
        config.google.client_id,
        config.google.client_secret,
        config.google.refresh_token
      );
      ok('Google token rafraîchi');
    } catch (e) { warn(`Google token: ${e.message}`); }
  }

  for (const boutique of config.boutiques) {
    const bid = boutique.id;
    results[bid] = {};
    console.log(`\n  ${boutique.icon || '🏪'}  ${C.bold}${boutique.name}${C.reset}`);

    if (boutique.shopify?.shop && !boutique.shopify.token.includes('XXX')) {
      try {
        const d = await syncShopify(boutique.shopify, dateStr);
        Object.assign(results[bid], d);
        ok(`Shopify  CA ${d.ca}€ · ${d.commandes} cmds · Retours ${d.retours}€`);
      } catch (e) { fail(`Shopify: ${e.message}`); }
    }

    if (boutique.klaviyo?.api_key && !boutique.klaviyo.api_key.includes('XXX')) {
      try {
        const d = await syncKlaviyo(boutique.klaviyo, dateStr);
        Object.assign(results[bid], d);
        ok(`Klaviyo  CA email ${d.ca_email}€`);
      } catch (e) { fail(`Klaviyo: ${e.message}`); }
    }

    // Google Ads via leo-ads-data.json (alimenté par le Google Ads Script)
    const adsWeekData = (loadGoogleAdsData()[bid] || {})[weekKey];
    if (adsWeekData) {
      Object.assign(results[bid], adsWeekData);
      ok(`Google Ads  ${adsWeekData.ads}€ · ${adsWeekData.impressions} impr · ${adsWeekData.clics} clics`);
    }

    if (!existingData.weeks[bid])          existingData.weeks[bid] = {};
    if (!existingData.weeks[bid][weekKey]) existingData.weeks[bid][weekKey] = {};
    existingData.weeks[bid][weekKey] = mergeDayIntoWeek(
      existingData.weeks[bid][weekKey],
      results[bid]
    );
  }

  return results;
}

// ── FULL SYNC HISTORIQUE ───────────────────────────────────────────────────────
async function runFullSync(config, existingData) {
  console.log(`\n${C.bold}${C.cyan}  🗄️  MODE FULL SYNC — Récupération de toutes les données historiques${C.reset}`);
  sep();

  for (const boutique of config.boutiques) {
    const bid = boutique.id;
    if (!existingData.weeks[bid]) existingData.weeks[bid] = {};

    console.log(`\n  ${boutique.icon || '🏪'}  ${C.bold}${boutique.name}${C.reset}`);
    sep();

    // ── Shopify full sync ──
    if (boutique.shopify?.shop && boutique.shopify.token && !boutique.shopify.token.includes('XXX')) {
      try {
        const shopifyWeeks = await fullSyncShopify(boutique.shopify);
        const weekCount = Object.keys(shopifyWeeks).length;

        for (const [weekKey, data] of Object.entries(shopifyWeeks)) {
          const existing = existingData.weeks[bid][weekKey] || {};
          // Preserve manual fields, overwrite synced fields
          existingData.weeks[bid][weekKey] = {
            // Manual fields preserved
            ...(existing.fournisseur != null && { fournisseur: existing.fournisseur }),
            ...(existing.livraison   != null && { livraison:   existing.livraison   }),
            ...(existing.shopify     != null && { shopify:     existing.shopify     }),
            ...(existing.autres      != null && { autres:      existing.autres      }),
            // Synced fields overwritten
            ...data,
            // Preserve ca_email if already synced (Klaviyo runs after)
            ...(existing.ca_email    != null && { ca_email:    existing.ca_email    }),
          };
        }
        ok(`Shopify: ${weekCount} semaines · ${Object.keys(shopifyWeeks).reduce((s, k) => s + (shopifyWeeks[k].commandes || 0), 0)} commandes totales`);
      } catch (e) { fail(`Shopify full sync: ${e.message}`); }
    }

    // ── Klaviyo full sync ──
    if (boutique.klaviyo?.api_key && !boutique.klaviyo.api_key.includes('XXX')) {
      try {
        const klaviyoWeeks = await fullSyncKlaviyo(boutique.klaviyo);
        for (const [weekKey, data] of Object.entries(klaviyoWeeks)) {
          if (!existingData.weeks[bid][weekKey]) existingData.weeks[bid][weekKey] = {};
          Object.assign(existingData.weeks[bid][weekKey], data);
        }
        ok(`Klaviyo: ${Object.keys(klaviyoWeeks).length} semaines avec CA email`);
      } catch (e) { fail(`Klaviyo full sync: ${e.message}`); }
    }

    // ── Google Ads full sync (via leo-ads-data.json) ──
    const adsAllData = loadGoogleAdsData()[bid] || {};
    const adsWeekKeys = Object.keys(adsAllData);
    if (adsWeekKeys.length > 0) {
      for (const weekKey of adsWeekKeys) {
        if (!existingData.weeks[bid][weekKey]) existingData.weeks[bid][weekKey] = {};
        Object.assign(existingData.weeks[bid][weekKey], adsAllData[weekKey]);
      }
      ok(`Google Ads: ${adsWeekKeys.length} semaines depuis leo-ads-data.json`);
    }

    // Résumé boutique
    const totalWeeks = Object.keys(existingData.weeks[bid] || {}).length;
    ok(`${boutique.name}: ${totalWeeks} semaines au total dans le dashboard`);
  }
}

// ── CONFIG : fichier local OU variables d'environnement (GitHub Actions) ──────
function loadConfigFromEnv() {
  log('🔑', "Mode GitHub Actions — lecture des secrets depuis les variables d'environnement");

  const BOUTIQUE_DEFS = [
    { id: 'emma',    name: "Les Peignoirs d'Emma", color: '#f472b6', icon: '🛁' },
    { id: 'aitavia', name: 'AïtaVia',              color: '#a78bfa', icon: '👟' },
    { id: 'kimoko',  name: 'Kimoko',               color: '#fbbf24', icon: '🛍️' },
  ];

  const boutiques = BOUTIQUE_DEFS.map(def => {
    const ID = def.id.toUpperCase().replace(/-/g, '_');
    const cfg = {
      ...def,
      shopify: {
        shop:  process.env[`BOUTIQUE_${ID}_SHOPIFY_SHOP`]  || '',
        token: process.env[`BOUTIQUE_${ID}_SHOPIFY_TOKEN`] || '',
      },
      klaviyo: {
        api_key: process.env[`BOUTIQUE_${ID}_KLAVIYO_KEY`] || '',
      },
      google_ads: {
        customer_id:     process.env[`BOUTIQUE_${ID}_GADS_CUSTOMER`]   || '',
        developer_token: process.env[`BOUTIQUE_${ID}_GADS_DEV_TOKEN`]  || '',
        manager_id:      process.env[`BOUTIQUE_${ID}_GADS_MANAGER_ID`] || '',
      },
    };
    if (!cfg.shopify.token && !cfg.klaviyo.api_key) {
      warn(`Boutique "${def.name}" ignorée (aucun token configuré)`);
      return null;
    }
    return cfg;
  }).filter(Boolean);

  return {
    boutiques,
    google: {
      client_id:     process.env.GOOGLE_CLIENT_ID     || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN || '',
    },
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.white}╔══════════════════════════════════════════════════╗`);
  console.log(`  🚀  LÉO FINANCE OS — SYNC v2.0`);
  console.log(`╚══════════════════════════════════════════════════╝${C.reset}\n`);

  // Détection auto : env vars (GitHub Actions) ou config.json (local)
  const useEnvVars = !!process.env.BOUTIQUE_EMMA_SHOPIFY_TOKEN
                  || !!process.env.BOUTIQUE_AITAVIA_SHOPIFY_TOKEN
                  || !!process.env.BOUTIQUE_KIMOKO_SHOPIFY_TOKEN;

  let config;
  if (useEnvVars) {
    config = loadConfigFromEnv();
  } else {
    if (!existsSync(CONFIG_FILE)) {
      fail(`config.json introuvable. Lance:\n     cp config.example.json config.json\n     puis remplis tes identifiants`);
      process.exit(1);
    }
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    log('📁', 'Mode local — lecture de config.json');
  }

  // Charger les données existantes (pour préserver les champs manuels)
  let existingData = { weeks: {}, synced_days: [], last_sync: null };
  if (existsSync(OUTPUT_FILE)) {
    const content = readFileSync(OUTPUT_FILE, 'utf-8');
    const match   = content.match(/window\.__SYNC_DATA__\s*=\s*(\{[\s\S]*?\});\s*$/);
    if (match) {
      try { existingData = { ...existingData, ...JSON.parse(match[1]) }; }
      catch { warn('Données existantes corrompues, départ à zéro.'); }
    }
  }

  // Parse arguments
  const args = process.argv.slice(2);

  if (args[0] === '--full-sync') {
    // ── MODE FULL SYNC ──
    await runFullSync(config, existingData);

  } else {
    // ── MODE NORMAL (journalier) ──
    let dates = [];
    if (args[0] === '--range') {
      dates = dateRange(args[1], args[2]);
      log('📆', `Plage: ${args[1]} → ${args[2]} (${dates.length} jours)`);
    } else if (args[0]) {
      dates = [args[0]];
    } else {
      dates = [yesterday()];
    }

    for (const dateStr of dates) {
      await syncDate(dateStr, config, existingData);
      if (!existingData.synced_days.includes(dateStr)) {
        existingData.synced_days.push(dateStr);
      }
    }
  }

  // Finaliser la sortie
  existingData.last_sync        = new Date().toISOString();
  existingData.synced_fields    = NUMERIC_FIELDS;
  existingData.boutiques_config = config.boutiques.map(b => ({
    id: b.id, name: b.name, color: b.color, icon: b.icon,
  }));

  const totalWeeks = Object.values(existingData.weeks)
    .reduce((s, b) => s + Object.keys(b).length, 0);

  const output = [
    '// Léo Finance OS — Sync Data (auto-généré, ne pas modifier)',
    `// Dernière sync: ${existingData.last_sync}`,
    `// Semaines synchronisées: ${totalWeeks}`,
    `window.__SYNC_DATA__ = ${JSON.stringify(existingData, null, 2)};`,
  ].join('\n');

  writeFileSync(OUTPUT_FILE, output);

  sep();
  ok(`${C.bold}Sync terminée !${C.reset}`);
  ok(`Fichier: leo-sync-data.js`);
  ok(`Semaines dans le dashboard: ${totalWeeks}`);
  console.log('');
}

main().catch(e => { fail(e.message); console.error(e); process.exit(1); });
