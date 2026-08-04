/* Маленький статический сервер для локальных проверок.
   Запуск отдельно:  node tests/serve.cjs 8123

   Обычно слушает только сам компьютер. Чтобы открыть сайт с телефона по
   домашней сети, вторым доводом передайте 0.0.0.0:
       node tests/serve.cjs 8123 0.0.0.0
   Проверки этим не пользуются — им как было, так и осталось 127.0.0.1.       */

var http = require('http');
var fs = require('fs');
var path = require('path');

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function startServer(root, port, host) {
  var server = http.createServer(function (req, res) {
    var rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    var file = path.join(root, rel.replace(/^\/+/, ''));
    if (file.indexOf(path.resolve(root)) !== 0) { res.writeHead(403).end('no'); return; }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('нет файла'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  });
  return new Promise(function (resolve) {
    server.listen(port, host || '127.0.0.1', function () { resolve(server); });
  });
}

module.exports = { startServer: startServer };

if (require.main === module) {
  var port = parseInt(process.argv[2], 10) || 8123;
  var host = process.argv[3] || '127.0.0.1';
  startServer(path.resolve(__dirname, '..'), port, host).then(function () {
    console.log('http://127.0.0.1:' + port + '/');
    if (host === '0.0.0.0') {
      // подсказываем адрес в домашней сети — с телефона нужен именно он
      var nets = require('os').networkInterfaces();
      Object.keys(nets).forEach(function (name) {
        (nets[name] || []).forEach(function (n) {
          if (n.family === 'IPv4' && !n.internal) {
            console.log('с телефона: http://' + n.address + ':' + port + '/   (' + name + ')');
          }
        });
      });
    }
  });
}
