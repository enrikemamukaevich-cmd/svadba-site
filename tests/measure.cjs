/* Замер сжатия: прогоняем исходники через shrinkPhoto самой страницы
   и печатаем вес превью. Ничего никуда не отправляем.
   Запуск: set NODE_PATH=... && node tests/measure.cjs                        */

var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');
var { startServer } = require('./serve.cjs');

var ROOT = path.resolve(__dirname, '..');
var SRC = path.join(__dirname, 'photos-src');
var PORT = 8127;

async function main() {
  var server = await startServer(ROOT, PORT);
  var browser = await chromium.launch();
  var page = await browser.newPage();
  page.on('pageerror', function (e) { console.log('  !! ' + e.message); });
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForFunction(function () { return typeof window.shrinkPhoto === 'function'; }, null, { timeout: 15000 });

  var files = fs.readdirSync(SRC);
  console.log('файл'.padEnd(26) + 'исходник'.padStart(10) + 'превью'.padStart(11) + '  размер превью');
  console.log('-'.repeat(70));

  var sizes = [];
  for (var i = 0; i < files.length; i++) {
    var buf = fs.readFileSync(path.join(SRC, files[i]));
    var res = await page.evaluate(async function (a) {
      var bin = atob(a.b64);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var file = new File([arr], a.name, { type: 'image/jpeg' });
      var t0 = performance.now();
      var r = await shrinkPhoto(file);
      return { size: r.blob.size, w: r.w, h: r.h, ms: Math.round(performance.now() - t0) };
    }, { b64: buf.toString('base64'), name: files[i] });

    sizes.push(res.size);
    console.log(files[i].padEnd(26) +
      ((buf.length / 1048576).toFixed(2) + ' МБ').padStart(10) +
      ((res.size / 1024).toFixed(0) + ' КБ').padStart(11) +
      '  ' + res.w + '×' + res.h + '  (' + res.ms + ' мс)');
  }

  sizes.sort(function (a, b) { return a - b; });
  var mid = sizes[Math.floor(sizes.length / 2)];
  var avg = sizes.reduce(function (a, b) { return a + b; }, 0) / sizes.length;
  console.log('-'.repeat(70));
  console.log('середина ' + (mid / 1024).toFixed(0) + ' КБ, среднее ' + (avg / 1024).toFixed(0) +
              ' КБ, самый тяжёлый ' + (sizes[sizes.length - 1] / 1024).toFixed(0) + ' КБ');

  await browser.close();
  server.close();
}

main().catch(function (e) { console.error(e); process.exit(2); });
