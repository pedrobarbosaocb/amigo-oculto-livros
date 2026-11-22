// Servidor estático para o Railway (Node puro, sem dependências).
// Serve index.html, app.js e gera config.js a partir das variáveis de ambiente
// SUPABASE_URL e SUPABASE_ANON_KEY (sem elas, o site roda em modo local).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

const config = 'window.AO_CONFIG = ' + JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
}) + ';\n';

const SECURITY = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', // os links levam chaves no hash; nada vaza por Referer
    'X-Frame-Options': 'DENY'
};

createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY).end(); return; }
    if (path === '/healthz') { res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/plain' }).end('ok'); return; }
    if (path === '/config.js') {
        res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(config);
        return;
    }
    const f = FILES[path];
    if (!f) { res.writeHead(302, { ...SECURITY, Location: '/' }).end(); return; }
    try {
        const body = await readFile(join(ROOT, f[0]));
        res.writeHead(200, { ...SECURITY, 'Content-Type': f[1], 'Cache-Control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : body);
    } catch {
        res.writeHead(500, SECURITY).end();
    }
}).listen(PORT, () => console.log(`amigo-oculto na porta ${PORT} (${config.includes('supabase.co') ? 'Supabase' : 'modo local'})`));
