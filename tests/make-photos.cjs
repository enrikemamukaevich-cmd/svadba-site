/* ============================================================================
   Готовит исходники для проверок этапа 4.

   Настоящие снимки с телефона на двенадцать мегапикселей в репозитории держать
   незачем, а готовые превью из бакета для проверки веса не годятся: они уже
   сжаты до пятидесяти килобайт, и на них загрузка покажет ложно хороший
   результат. Поэтому из реальных фотографий Энрике собираем то, что отдаёт
   галерея айфона: та же картинка, растянутая до 3024×4032, с зерном матрицы
   и без повторного сжатия — файл на несколько мегабайт.

   Запуск:  set NODE_PATH=<папка playwright>\node_modules && node tests/make-photos.cjs
   Складывает в tests/photos-src.
   ============================================================================ */

var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');

var BASE = path.join(__dirname, 'photos');       // готовые превью из бакета
var OUT = path.join(__dirname, 'photos-src');    // «снимки с телефона»

// Сколько мегапикселей выдаёт телефон
var PHONE_LONG = 4032;

/* Вклеиваем в готовый JPEG блок EXIF с одной пометкой — поворотом.
   Точно так же его вклеивают проверки этапа 2. */
function injectExif(jpeg, orientation) {
  var app1 = Buffer.from([
    0xFF, 0xE1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

// Размеры читаем прямо из заголовка JPEG, без библиотек
function jpegSize(buf) {
  var i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    var m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/* Что делаем в браузере: растягиваем снимок до размера телефонной матрицы
   и возвращаем ему мелкую детализацию.

   Просто зерно тут не помогает: превью уменьшается втрое, и зерно при этом
   усредняется в ровный тон — файл выходит подозрительно лёгким. Настоящий
   снимок держит вес за счёт деталей покрупнее: листва, складки ткани, лица
   в толпе, блёстки. Их и подмешиваем — короткими мазками по два-три десятка
   точек, которые уменьшение переживают. Число мазков задаёт, насколько
   «занятой» получится кадр: в зале будут и гладкие портреты, и пёстрые общие
   планы, поэтому исходники делаем разными. */
async function blowUp(page, dataUrl, longSide, grain, detail) {
  return await page.evaluate(async function (a) {
    var img = new Image();
    await new Promise(function (res, rej) {
      img.onload = res; img.onerror = rej; img.src = a.src;
    });

    var k = a.long / Math.max(img.naturalWidth, img.naturalHeight);
    var c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    var x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);

    // мазки крупнее зерна: именно они и остаются в превью
    x.lineCap = 'round';
    for (var s = 0; s < (a.detail || 0); s++) {
      var px = Math.random() * c.width;
      var py = Math.random() * c.height;
      var len = 10 + Math.random() * 34;
      var ang = Math.random() * Math.PI * 2;
      x.strokeStyle = 'rgba(' + ((Math.random() * 255) | 0) + ',' +
                      ((Math.random() * 255) | 0) + ',' +
                      ((Math.random() * 255) | 0) + ',' + (0.10 + Math.random() * 0.22).toFixed(3) + ')';
      x.lineWidth = 2 + Math.random() * 7;
      x.beginPath();
      x.moveTo(px, py);
      x.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
      x.stroke();
    }

    if (a.grain > 0) {
      var d = x.getImageData(0, 0, c.width, c.height);
      var p = d.data;
      for (var i = 0; i < p.length; i += 4) {
        var n = (Math.random() * 2 - 1) * a.grain;
        p[i] += n; p[i + 1] += n; p[i + 2] += n;
      }
      x.putImageData(d, 0, 0);
    }

    var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.95); });
    var buf = new Uint8Array(await blob.arrayBuffer());
    var out = '';
    for (var j = 0; j < buf.length; j += 8192) {
      out += String.fromCharCode.apply(null, buf.subarray(j, j + 8192));
    }
    return { b64: btoa(out), w: c.width, h: c.height };
  }, { src: dataUrl, long: longSide, grain: grain, detail: detail });
}

/* Заведомо трудный для сжатия снимок: мелкий узор по всему полю. Такие
   в зале встречаются — блёстки на платье, гирлянды, листва. На нём проверяем,
   что превью всё равно не перевалит за 250 КБ. */
async function hardOne(page, w, h) {
  return await page.evaluate(async function (a) {
    var c = document.createElement('canvas');
    c.width = a.w; c.height = a.h;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, a.w, a.h);
    g.addColorStop(0, '#f2f2f2'); g.addColorStop(1, '#303030');
    x.fillStyle = g; x.fillRect(0, 0, a.w, a.h);

    for (var i = 0; i < 5000; i++) {
      x.beginPath();
      x.strokeStyle = 'rgba(' + ((Math.random() * 255) | 0) + ',' +
                      ((Math.random() * 255) | 0) + ',' + ((Math.random() * 255) | 0) + ',.55)';
      x.lineWidth = 1 + Math.random() * 3;
      x.moveTo(Math.random() * a.w, Math.random() * a.h);
      x.lineTo(Math.random() * a.w, Math.random() * a.h);
      x.stroke();
    }
    var d = x.getImageData(0, 0, a.w, a.h);
    var p = d.data;
    for (var j = 0; j < p.length; j += 4) {
      var n = (Math.random() * 2 - 1) * 40;
      p[j] += n; p[j + 1] += n; p[j + 2] += n;
    }
    x.putImageData(d, 0, 0);

    var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.95); });
    var buf = new Uint8Array(await blob.arrayBuffer());
    var out = '';
    for (var q = 0; q < buf.length; q += 8192) {
      out += String.fromCharCode.apply(null, buf.subarray(q, q + 8192));
    }
    return { b64: btoa(out), w: a.w, h: a.h };
  }, { w: w, h: h });
}

async function main() {
  if (!fs.existsSync(BASE)) {
    console.error('Нет папки ' + BASE + ' — сначала скачайте превью из бакета.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.readdirSync(OUT).forEach(function (f) { fs.unlinkSync(path.join(OUT, f)); });

  /* Разные пропорции — вертикальные, горизонтальные и квадрат — и разная
     «занятость» кадра: от гладкого портрета до пёстрого общего плана. */
  var picks = [
    { f: '01-4565502f-1200x1600.jpg', detail: 90000 },
    { f: '10-825cee79-1440x1800.jpg', detail: 60000 },
    { f: '15-ecd5e3ab-1000x1500.jpg', detail: 30000 },
    { f: '06-32052dda-900x1600.jpg',  detail: 120000 },
    { f: '21-a30eed59-1080x1620.jpg', detail: 8000 },
    { f: '04-80ff2261-1920x1080.jpg', detail: 75000 },
    { f: '11-5f2a549c-1800x1440.jpg', detail: 45000 },
    { f: '14-d1137344-1500x1000.jpg', detail: 100000 },
    { f: '05-1d93adb8-1080x1080.jpg', detail: 20000 }
  ].filter(function (p) { return fs.existsSync(path.join(BASE, p.f)); });

  var browser = await chromium.launch();
  var page = await browser.newPage();
  await page.goto('about:blank');

  console.log('Собираю исходники «как с телефона»...\n');

  for (var i = 0; i < picks.length; i++) {
    var src = fs.readFileSync(path.join(BASE, picks[i].f));
    var dataUrl = 'data:image/jpeg;base64,' + src.toString('base64');
    var big = await blowUp(page, dataUrl, PHONE_LONG, 9, picks[i].detail);
    var buf = Buffer.from(big.b64, 'base64');
    var name = 'foto-' + String(i + 1).padStart(2, '0') + '-' + big.w + 'x' + big.h + '.jpg';
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log('  ' + name + '  ' + (buf.length / 1048576).toFixed(2) + ' МБ');
  }

  /* Снимок, помеченный поворотом на 90°: широкий кадр обязан приехать в ленту
     вертикальным. Именно так айфон отдаёт фотографии, снятые «стоя». */
  var wide = await blowUp(page, 'data:image/jpeg;base64,' +
    fs.readFileSync(path.join(BASE, '04-80ff2261-1920x1080.jpg')).toString('base64'), 3600, 9, 55000);
  var turned = injectExif(Buffer.from(wide.b64, 'base64'), 6);
  fs.writeFileSync(path.join(OUT, 'povorot-6-' + wide.w + 'x' + wide.h + '.jpg'), turned);
  console.log('  povorot-6-' + wide.w + 'x' + wide.h + '.jpg  ' +
              (turned.length / 1048576).toFixed(2) + ' МБ  (помечен поворотом на 90°)');

  // трудный для сжатия
  var hard = await hardOne(page, 3024, 4032);
  var hardBuf = Buffer.from(hard.b64, 'base64');
  fs.writeFileSync(path.join(OUT, 'uzor-3024x4032.jpg'), hardBuf);
  console.log('  uzor-3024x4032.jpg  ' + (hardBuf.length / 1048576).toFixed(2) + ' МБ  (мелкий узор, жмётся плохо)');

  await browser.close();

  var files = fs.readdirSync(OUT);
  console.log('\nГотово: ' + files.length + ' исходников в ' + OUT);
  files.forEach(function (f) {
    var b = fs.readFileSync(path.join(OUT, f));
    var s = jpegSize(b);
    console.log('  ' + f + '  ' + (s ? s.w + '×' + s.h : '?') + '  ' + (b.length / 1048576).toFixed(2) + ' МБ');
  });
}

main().catch(function (e) {
  console.error('Сорвалось: ' + (e && e.stack || e));
  process.exit(2);
});
