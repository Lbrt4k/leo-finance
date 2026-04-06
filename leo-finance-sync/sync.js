#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          LÉO FINANCE OS — SYNC ENGINE v1.0                  ║
 * ║  Shopify · Google Ads · Klaviyo → leo-sync-data.js          ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node sync.js              → hier (auto)
 *   node sync.js 2026-04-05   → date spécifique
 *   node sync.js --range 2026-03-01 2026-04-05  → plage de dates
 *
 * Champs automatiques:
 *   ✅ CA Brut          (Shopify Orders)
 *   ✅ Retours          (Shopify Refunds)
 *   ✅ CA Email         (Klaviyo Revenue Attribution)
 *   ✅ Commandes        (Shopify Orders count)
 *   ✅ Nouveaux clients (Shopify Customers)
 *   ✅ Clients récurr.  (Shopify Customers history)
 *   ✅ Ads (dépenses)   (Google Ads API)
 *   ✅ Impressions      (Google Ads API)
 *   ✅ Clics            (Google Ads API)
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

// ── SHOPIFY ────────────────────────────────────────────────────────────────────
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

async function syncShopify(cfg, dateStr) {
  const { shop, token } = cfg;
  const start = `${dateStr}T00:00:00+00:00`;
  const end   = `${dateStr}T23:59:59+00:00`;

  // ── Orders ──
  let allOrders = [];
  let params = {
    status: 'any',
    created_at_min: start,
    created_at_max: end,
    limit: 250,
    fields: 'id,total_price,financial_status,customer,refunds,total_shipping_price_set,gateway',
  };

  // Paginate via limit (simplified — handles up to ~1000 orders/day)
  for (let page = 0; page < 4; page++) {
    const data = await shopifyGet(shop, token, 'orders.json', params);
    const orders = data.orders || [];
    allOrders = allOrders.concat(orders);
    if (orders.length < 250) break;
    // Next page: use last order ID as since_id
    params = { ...params, since_id: orders[orders.length - 1].id };
    delete params.created_at_min; delete params.created_at_max;
  }

  // ── CA & Commandes ──
  const ca = allOrders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const commandes = allOrders.length;

  // ── Retours (refunds) ──
  let retours = 0;
  allOrders.forEach(o => {
    (o.refunds || []).forEach(r => {
      (r.transactions || []).forEach(t => {
        if (['refund', 'void'].includes(t.kind)) retours += parseFloat(t.amount || 0);
      });
    });
  });

  // ── Clients nouveaux vs récurrents ──
  let nouveaux = 0, recurrents = 0;
  const checked = new Set();
  for (const o of allOrders) {
    const cid = o.customer?.id;
    if (!cid) { nouveaux++; continue; }
    if (checked.has(cid)) { recurrents++; continue; }
    checked.add(cid);
    try {
      const { customer } = await shopifyGet(shop, token, `customers/${cid}.json`);
      // orders_count includes current order; >1 means returning
      if ((customer?.orders_count || 0) > 1) recurrents++;
      else nouveaux++;
    } catch { nouveaux++; }
    await sleep(100); // gentle rate limiting
  }

  return {
    ca:                 Math.round(ca       * 100) / 100,
    commandes,
    retours:            Math.round(retours  * 100) / 100,
    nouveaux_clients:   nouveaux,
    clients_recurrents: recurrents,
  };
}

// ── KLAVIYO ───────────────────────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(`Klaviyo /${endpoint}: HTTP ${res.status}`);
  return res.json();
}

async function syncKlaviyo(cfg, dateStr) {
  const { api_key } = cfg;

  // Find "Placed Order" metric ID
  const metrics = await klaviyoGet(api_key, 'metrics', { 'filter': 'contains(name,"Placed Order")' });
  const metricId = metrics.data?.[0]?.id;
  if (!metricId) { warn('Klaviyo: metric "Placed Order" introuvable'); return { ca_email: 0 }; }

  const start = `${dateStr}T00:00:00+00:00`;
  const nextDay = new Date(dateStr + 'T12:00:00Z');
  nextDay.setDate(nextDay.getDate() + 1);
  const end = nextDay.toISOString().split('T')[0] + 'T00:00:00+00:00';

  const data = await klaviyoPost(api_key, 'metric-aggregates/', {
    data: {
      type: 'metric-aggregate',
      attributes: {
        metric_id: metricId,
        interval: 'day',
        measurements: ['sum_value'],
        filter: `greater-or-equal(datetime,${start}),less-than(datetime,${end})`,
        by: ['$attributed_channel'],
        sort: '-datetime',
      },
    },
  });

  // Sum revenue attributed to email channel
  let ca_email = 0;
  const results = data.data?.attributes?.results || [];
  for (const r of results) {
    const channel = r.dimensions?.[0]?.toLowerCase() || '';
    if (channel.includes('email') || channel.includes('flow') || channel.includes('campaign')) {
      ca_email += parseFloat(r.measurements?.sum_value?.[0] || 0);
    }
  }

  return { ca_email: Math.round(ca_email * 100) / 100 };
}

// ── GOOGLE ADS ────────────────────────────────────────────────────────────────
async function syncGoogleAds(cfg, dateStr, accessToken) {
  const { customer_id, developer_token, manager_id } = cfg;
  const cid = customer_id.replace(/-/g, '');

  const query = `
    SELECT
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks
    FROM customer
    WHERE segments.date = '${dateStr}'
  `.trim();

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developer_token,
    'Content-Type': 'application/json',
  };
  if (manager_id) headers['login-customer-id'] = manager_id.replace(/-/g, '');

  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${cid}/googleAds:search`,
    { method: 'POST', headers, body: JSON.stringify({ query }) }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  let ads = 0, impressions = 0, clics = 0;

  for (const result of (data.results || [])) {
    ads        += parseInt(result.metrics?.costMicros || 0) / 1_000_000;
    impressions += parseInt(result.metrics?.impressions || 0);
    clics       += parseInt(result.metrics?.clicks || 0);
  }

  return {
    ads:         Math.round(ads * 100) / 100,
    impressions: Math.round(impressions),
    clics:       Math.round(clics),
  };
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

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function syncDate(dateStr, config, existingData) {
  const weekKey = getISOWeekKey(dateStr);
  console.log(`\n${C.bold}${C.cyan}  📅 ${dateStr}  →  ${weekKey}${C.reset}`);
  sep();

  const results = {};

  // Refresh Google token once per run
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

    // Shopify
    if (boutique.shopify?.shop && !boutique.shopify.token.includes('XXX')) {
      try {
        const d = await syncShopify(boutique.shopify, dateStr);
        Object.assign(results[bid], d);
        ok(`Shopify  CA ${d.ca}€ · ${d.commandes} cmds · Retours ${d.retours}€`);
      } catch (e) { fail(`Shopify: ${e.message}`); }
    }

    // Klaviyo
    if (boutique.klaviyo?.api_key && !boutique.klaviyo.api_key.includes('XXX')) {
      try {
        const d = await syncKlaviyo(boutique.klaviyo, dateStr);
        Object.assign(results[bid], d);
        ok(`Klaviyo  CA email ${d.ca_email}€`);
      } catch (e) { fail(`Klaviyo: ${e.message}`); }
    }

    // Google Ads
    if (boutique.google_ads?.customer_id && !boutique.google_ads.customer_id.includes('XXX') && googleToken) {
      try {
        const d = await syncGoogleAds(boutique.google_ads, dateStr, googleToken);
        Object.assign(results[bid], d);
        ok(`Google Ads  ${d.ads}€ · ${d.impressions} impr · ${d.clics} clics`);
      } catch (e) { fail(`Google Ads: ${e.message}`); }
    }

    // Merge into weekly store
    if (!existingData.weeks[bid])          existingData.weeks[bid] = {};
    if (!existingData.weeks[bid][weekKey]) existingData.weeks[bid][weekKey] = {};
    existingData.weeks[bid][weekKey] = mergeDayIntoWeek(
      existingData.weeks[bid][weekKey],
      results[bid]
    );
  }

  return results;
}

// ── CONFIG : fichier local OU variables d'environnement (GitHub Actions) ──────
function loadConfigFromEnv() {
  log('🔑', 'Mode GitHub Actions — lecture des secrets depuis les variables d\'environnement');

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
        customer_id:     process.env[`BOUTIQUE_${ID}_GADS_CUSTOMER`]  || '',
        developer_token: process.env[`BOUTIQUE_${ID}_GADS_DEV_TOKEN`] || '',
        manager_id:      process.env[`BOUTIQUE_${ID}_GADS_MANAGER_ID`] || '',
      },
    };
    // Skip boutiques with no Shopify token configured
    if (!cfg.shopify.token) {
      warn(`Boutique "${def.name}" ignorée (BOUTIQUE_${ID}_SHOPIFY_TOKEN absent)`);
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

async function main() {
  console.log(`\n${C.bold}${C.white}╔══════════════════════════════════════════════════╗`);
  console.log(`  🚀  LÉO FINANCE OS — SYNC`);
  console.log(`╚══════════════════════════════════════════════════╝${C.reset}\n`);

  // Détection automatique : env vars (GitHub Actions) ou config.json (local)
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

  // Parse arguments
  const args = process.argv.slice(2);
  let dates = [];
  if (args[0] === '--range') {
    dates = dateRange(args[1], args[2]);
    log('📆', `Plage: ${args[1]} → ${args[2]} (${dates.length} jours)`);
  } else if (args[0]) {
    dates = [args[0]];
  } else {
    dates = [yesterday()];
  }

  // Load existing sync data
  let existingData = { weeks: {}, synced_days: [], last_sync: null };
  if (existsSync(OUTPUT_FILE)) {
    const content = readFileSync(OUTPUT_FILE, 'utf-8');
    const match   = content.match(/window\.__SYNC_DATA__\s*=\s*(\{[\s\S]*?\});\s*$/);
    if (match) {
      try { existingData = { ...existingData, ...JSON.parse(match[1]) }; }
      catch { warn('Données existantes corrompues, départ à zéro.'); }
    }
  }

  // Sync each date
  for (const dateStr of dates) {
    await syncDate(dateStr, config, existingData);
    if (!existingData.synced_days.includes(dateStr)) {
      existingData.synced_days.push(dateStr);
    }
  }

  // Finalize output
  existingData.last_sync         = new Date().toISOString();
  existingData.synced_fields     = NUMERIC_FIELDS;
  existingData.boutiques_config  = config.boutiques.map(b => ({
    id: b.id, name: b.name, color: b.color, icon: b.icon,
  }));

  const output = [
    '// Léo Finance OS — Sync Data (auto-généré, ne pas modifier)',
    `// Dernière sync: ${existingData.last_sync}`,
    `// Jours synchronisés: ${existingData.synced_days.length}`,
    `window.__SYNC_DATA__ = ${JSON.stringify(existingData, null, 2)};`,
  ].join('\n');

  writeFileSync(OUTPUT_FILE, output);

  sep();
  ok(`${C.bold}Sync terminée !${C.reset}`);
  ok(`Fichier: leo-sync-data.js`);
  ok(`Jours synchronisés: ${existingData.synced_days.length}`);
  console.log('');
}

main().catch(e => { fail(e.message); console.error(e); process.exit(1); });
