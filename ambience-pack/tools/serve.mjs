/* Крошечный статический сервер без зависимостей — только чтобы послушать демо.
   Запуск: node tools/serve.mjs 8080  (слушает 0.0.0.0, отдаёт корень пакета) */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const root = process.cwd();
const port = Number(process.argv[2] || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let path = join(root, normalize(url).replace(/^(\.\.[/\\])+/, ''));
    const st = await stat(path).catch(() => null);
    if (st && st.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': types[extname(path)] || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('не найдено');
  }
}).listen(port, '0.0.0.0', () => console.log(`демо: http://0.0.0.0:${port}/demo/`));
