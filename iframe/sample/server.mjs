import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const files = {
  '/': 'index.html', '/index.html': 'index.html', '/keys-client.js': 'keys-client.js',
  '/styles.css': 'styles.css', '/stellar-signer.js': 'stellar-signer.js', '/penpal.js': 'penpal.js',
  '/LICENSE': 'LICENSE', '/penpal-LICENSE': 'penpal-LICENSE',
};
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css' };

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405).end();
    return;
  }
  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; }
  catch { response.writeHead(400).end(); return; }
  const license = pathname.startsWith('/licenses/') && /^[\w@.-]+$/.test(pathname.slice(10));
  const file = files[pathname] ?? (license ? pathname.slice(1) : null);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(file, import.meta.url));
    response.writeHead(200, { 'Content-Type': `${mime[file.split('.').at(-1)] ?? 'text/plain'}; charset=utf-8` });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {
  console.log(`Sample listening on port ${server.address().port}`);
});
