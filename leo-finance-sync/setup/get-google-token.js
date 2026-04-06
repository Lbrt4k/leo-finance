#!/usr/bin/env node
/**
 * Léo Finance — Google OAuth Setup (à lancer une seule fois)
 * Génère le refresh_token pour Google Ads + GA4
 *
 * Usage: node setup/get-google-token.js
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dir, '..', 'config.json');

if (!existsSync(CONFIG_FILE)) {
  console.error('❌  config.json introuvable. Copie d\'abord config.example.json → config.json');
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
const { client_id, client_secret } = config.google || {};

if (!client_id || client_id.includes('XXXX')) {
  console.error('❌  Remplis google.client_id et google.client_secret dans config.json avant de lancer ce script.');
  process.exit(1);
}

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/analytics.readonly',
].join(' ');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
  access_type: 'offline',
  prompt: 'consent',
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  🔑  Léo Finance — Google OAuth Setup');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('1. Ouvre cette URL dans ton navigateur :\n');
console.log('   ' + authUrl + '\n');
console.log('2. Connecte-toi avec le compte Google Ads / Analytics');
console.log('3. Autorise l\'accès → tu seras redirigé sur localhost\n');
console.log('⏳  En attente du callback OAuth...\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400); res.end('No code received');
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id,
        client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      res.writeHead(500);
      res.end('<h1>❌ Erreur : pas de refresh_token. Réessaie avec prompt=consent.</h1>');
      console.error('❌  Erreur tokens:', tokens);
      server.close();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0d0d1a;color:#fff">
        <h1 style="color:#10b981">✅ Succès !</h1>
        <p>Copie le refresh_token affiché dans ton terminal.</p>
      </body></html>
    `);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ✅  REFRESH TOKEN OBTENU');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(tokens.refresh_token);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  → Colle ce token dans config.json > google.refresh_token');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    server.close();
  } catch (e) {
    res.writeHead(500); res.end('Erreur: ' + e.message);
    console.error('❌  Exception:', e);
    server.close();
  }
});

server.listen(PORT);
