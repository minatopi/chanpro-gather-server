const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/set') {
    // SameSite=None を使う場合は HTTPS 環境と Secure 属性が必要
    res.writeHead(200, {
      'Set-Cookie': 'test_httponly=secret123; HttpOnly; Path=/; SameSite=Lax',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('HttpOnly Cookie を発行しました');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <button onclick="fetch('/set').then(() => alert('発行完了'))">Cookie発行</button>
    <button onclick="alert('document.cookie: ' + document.cookie)">JSから取得</button>
  `);
});

server.listen(3000, () => {
  console.log('http://localhost:3000 で起動中');
});
