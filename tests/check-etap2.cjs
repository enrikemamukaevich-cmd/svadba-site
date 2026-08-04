/* ============================================================================
   Проверки этапа 2 через Playwright.
   Запуск:  set NODE_PATH=<папка с playwright>\node_modules && node tests/check-etap2.cjs
   Скриншоты складываются в tests/shots.
   ============================================================================ */

var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');
var { startServer } = require('./serve.cjs');

var ROOT = path.resolve(__dirname, '..');
var SHOTS = path.join(__dirname, 'shots');
var PORT = 8123;
// по умолчанию проверяем локальную копию; SVADBA_BASE — чтобы прогнать боевой адрес
var LIVE = process.env.SVADBA_BASE || '';
var BASE = LIVE || ('http://127.0.0.1:' + PORT + '/');

var SUPA = 'https://hwnmqcvvdlfqscoufyki.supabase.co';
var KEY = 'sb_publishable_UQtVcMc-DoTEFFvDKE0mxQ_PV5nCSnn';

var results = [];
var madeGuests = [];

function ok(name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail || '' });
  console.log((pass ? '  ДА  ' : '  НЕТ ') + name + (detail ? ' — ' + detail : ''));
}

function db(pathq, opts) {
  var o = opts || {};
  o.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, o.headers || {});
  return fetch(SUPA + '/rest/v1/' + pathq, o);
}

function rnd() { return Math.random().toString(36).slice(2, 8); }

/* --- вспомогательное ----------------------------------------------------- */

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

/* Перехват ответа базы: подменяем и не забываем разрешить обращение с другого
   адреса, иначе браузер отбросит ответ ещё до нашего кода. */
function mock(page, pattern, body) {
  return page.route(pattern, function (route) {
    var cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'access-control-expose-headers': 'content-range'
    };
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: cors, body: '' });
    }
    route.fulfill({
      status: 200,
      headers: Object.assign({ 'content-type': 'application/json' }, cors),
      body: JSON.stringify(body)
    });
  });
}

function shot(page, name) {
  return page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

function onScreen(page, id) {
  return page.locator('#' + id).evaluate(function (n) { return n.classList.contains('is-on'); });
}

/* Ник вошедшего гостя. В ленте этапа 3 его не пишут — в шапке только значок,
   а сам ник виден на своей карточке, куда этот значок и ведёт. */
async function whoAmI(page) {
  await page.click('#btn-me');
  await page.waitForSelector('#s-guest.is-on', { timeout: 20000 });
  var nick = (await page.locator('#guest-nick').textContent()).trim();
  await page.click('#guest-back');
  await page.waitForSelector('#s-feed.is-on', { timeout: 20000 });
  return nick;
}

async function typePin(page, sel, pin) {
  await page.locator(sel + ' .pin-cell').first().click();
  await page.keyboard.type(pin, { delay: 20 });
}

/* Ждать конца запроса, а не «примерно две секунды». По боевому адресу база
   отвечает дольше, чем локально, и фиксированная пауза ловит момент, когда
   кнопка ещё занята: набранный пин потом стирается ответом. */
function notBusy(page, id) {
  return page.waitForFunction(function (i) {
    var b = document.getElementById(i);
    return b && !/Проверяем|Заходим|Готовим/.test(b.textContent);
  }, id, { timeout: 30000 });
}

/* --- сами проверки ------------------------------------------------------- */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  var server = LIVE ? null : await startServer(ROOT, PORT);
  console.log('Проверяю адрес: ' + BASE + '\n');
  var browser = await chromium.launch();

  var ctxOpts = {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: 'ru-RU'
  };

  // сюда пишем всё, что прилетело из сети, — пригодится для проверки 8
  var seen = [];
  function watch(page) {
    page.on('response', async function (r) {
      if (r.url().indexOf(SUPA) !== 0) return;
      var body = '';
      try { body = await r.text(); } catch (e) { body = ''; }
      seen.push({ url: r.url(), body: body });
    });
    page.on('pageerror', function (e) { console.log('  ! ошибка на странице: ' + e.message); });
  }

  var nickA = 'тест-' + rnd();
  var pinA = '4821';

  /* ---------------- 1. Регистрация с верным словом ---------------------- */
  var ctx = await browser.newContext(ctxOpts);
  var page = await ctx.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForSelector('#s-start.is-on');
  await page.waitForFunction(function () {
    return !/…/.test(document.getElementById('photo-count').textContent);
  }, null, { timeout: 15000 }).catch(function () {});
  await shot(page, '01-start.png');

  var counterText = await page.locator('#photo-count').textContent();
  ok('Счётчик фото на старте читается из базы', /^Загружено фото: \d+$/.test(counterText.trim()), counterText.trim());

  await page.click('#go-reg');
  await page.fill('#reg-nick', nickA);
  await page.fill('#reg-word', '  ЛЮБОВЬ ');           // регистр и пробелы не важны
  await typePin(page, '#reg-pin', pinA);

  var cells = await page.locator('#reg-pin .pin-cell').evaluateAll(function (ns) { return ns.map(function (n) { return n.value; }); });
  ok('Пин разложился по клеткам сам', cells.join('') === pinA, cells.join(' '));
  var im = await page.locator('#reg-pin .pin-cell').first().getAttribute('inputmode');
  ok('У клеток пина цифровая клавиатура', im === 'numeric', 'inputmode=' + im);

  await shot(page, '02-registraciya.png');
  await page.click('#reg-next');
  await page.waitForSelector('#s-avatar.is-on', { timeout: 15000 });
  ok('Верное слово пропускает дальше', true, 'ник ' + nickA);
  await shot(page, '03-avatar.png');

  await page.click('#avatar-grid .ava[data-value="3"]');
  await page.click('#reg-finish');
  await page.waitForSelector('#s-feed.is-on', { timeout: 20000 });
  var feedNick = await whoAmI(page);
  await shot(page, '07-lenta-posle-registracii.png');
  madeGuests.push(nickA);

  var row = await (await db('guests_public?select=*&nick=eq.' + encodeURIComponent(nickA))).json();
  ok('1. Регистрация прошла, запись в базе есть',
    row.length === 1 && row[0].avatar_kind === 'preset' && row[0].avatar_value === '3' && feedNick === nickA,
    'в базе: ' + JSON.stringify(row[0] || null));

  /* ---------------- 7. Гость остаётся внутри после перезагрузки ---------- */
  await page.reload();
  await page.waitForSelector('#s-feed.is-on', { timeout: 20000 });
  var stillNick = await whoAmI(page);
  await shot(page, '08-posle-perezagruzki.png');
  ok('7. После перезагрузки гость остался внутри', stillNick === nickA, 'ник ' + stillNick);

  /* ---------------- 8. Пин и secret наружу не текут ---------------------- */
  var pub = await (await db('guests_public?select=*&limit=5')).json();
  var pubKeys = Object.keys(pub[0] || {});
  var pubClean = pubKeys.every(function (k) { return !/pin|secret|hash/i.test(k); });

  var stored = await page.evaluate(function () { return localStorage.getItem('svadba.guest'); });
  var secret = JSON.parse(stored).secret;

  var leaks = seen.filter(function (r) {
    return r.body && r.body.indexOf(secret) >= 0 && !/\/rpc\/(register_guest|check_pin)$/.test(r.url.split('?')[0]);
  });
  var pinLeaks = seen.filter(function (r) { return r.body && r.body.indexOf('"' + pinA + '"') >= 0; });
  var publicLeaks = seen.filter(function (r) {
    return /guests_public/.test(r.url) && /secret|pin/i.test(r.body);
  });

  ok('8. Пин и secret не видны в guests_public и в сетевых ответах',
    pubClean && leaks.length === 0 && pinLeaks.length === 0 && publicLeaks.length === 0,
    'поля витрины: ' + pubKeys.join(', ') + '; secret вернулся только из register_guest');

  await ctx.close();

  /* ---------------- 2. Неверное кодовое слово --------------------------- */
  ctx = await browser.newContext(ctxOpts); page = await ctx.newPage(); watch(page);
  await page.goto(BASE);
  await page.click('#go-reg');
  await page.fill('#reg-nick', 'тест-' + rnd());
  await page.fill('#reg-word', 'дружба');
  await typePin(page, '#reg-pin', '1111');
  await page.click('#reg-next');
  await notBusy(page, 'reg-next');
  var wordErr = (await page.locator('#err-word').textContent()).trim();
  await shot(page, '04-slovo-ne-podhodit.png');
  ok('2. Неверное слово отбивается',
    wordErr === 'Слово не подходит. Спросите у ведущего' && await onScreen(page, 's-reg'),
    wordErr);

  /* ---------------- 3. Занятый ник -------------------------------------- */
  await page.fill('#reg-nick', nickA.toUpperCase());     // и в другом регистре тоже занят
  await page.fill('#reg-word', 'любовь');
  await page.click('#reg-next');
  await notBusy(page, 'reg-next');
  var nickErr = (await page.locator('#err-nick').textContent()).trim();
  await shot(page, '05-nik-zanyat.png');
  ok('3. Занятый ник отбивается',
    nickErr === 'Этот ник уже взяли, придумайте другой' && await onScreen(page, 's-reg'),
    nickErr);
  await ctx.close();

  /* ---------------- 4. Вход по нику и пину ------------------------------ */
  ctx = await browser.newContext(ctxOpts); page = await ctx.newPage(); watch(page);
  await page.goto(BASE);
  await page.click('#go-login');
  await shot(page, '06-vhod.png');
  await page.fill('#log-nick', nickA);
  await typePin(page, '#log-pin', '9999');
  await page.click('#log-go');
  await notBusy(page, 'log-go');
  var logErr = (await page.locator('#err-login').textContent()).trim();
  var left = (await page.locator('#login-left').textContent()).trim();
  await shot(page, '06b-vhod-oshibka.png');
  var badPinRejected = logErr === 'Неверный ник или пин' && await onScreen(page, 's-login');

  await page.fill('#log-nick', nickA);
  await typePin(page, '#log-pin', pinA);
  await page.click('#log-go');
  await page.waitForSelector('#s-feed.is-on', { timeout: 20000 });
  ok('4. Вход по верному пину работает, по неверному — нет',
    badPinRejected && await onScreen(page, 's-feed'),
    'после ошибки: «' + logErr + '», ' + left);
  await ctx.close();

  /* ---------------- 5. Три ошибки подряд — пауза 60 секунд -------------- */
  ctx = await browser.newContext(ctxOpts); page = await ctx.newPage(); watch(page);
  await page.goto(BASE);
  await page.click('#go-login');
  for (var i = 0; i < 3; i++) {
    await page.fill('#log-nick', nickA);
    await typePin(page, '#log-pin', '000' + i);
    await page.click('#log-go');
    await page.waitForFunction(function (n) {
      var s = JSON.parse(localStorage.getItem('svadba.login') || '{}');
      return (s.fails || 0) >= n || (s.until || 0) > Date.now();
    }, i + 1, { timeout: 30000 });
  }
  var btnDisabled = await page.locator('#log-go').isDisabled();
  var btnText = (await page.locator('#log-go').textContent()).trim();
  var leftText = (await page.locator('#login-left').textContent()).trim();
  await shot(page, '09-pauza-60-sekund.png');
  var firstNum = parseInt((btnText.match(/\d+/) || [0])[0], 10);
  await page.waitForTimeout(2100);
  var secondNum = parseInt(((await page.locator('#log-go').textContent()).match(/\d+/) || [0])[0], 10);

  // ждать вживую минуту незачем: подводим будильник и смотрим, что кнопка ожила
  await page.evaluate(function () {
    localStorage.setItem('svadba.login', JSON.stringify({ fails: 3, until: Date.now() + 1500 }));
  });
  await page.waitForTimeout(2600);
  var backAlive = !(await page.locator('#log-go').isDisabled());

  ok('5. Три ошибки подряд включают паузу на 60 секунд',
    btnDisabled && firstNum >= 55 && firstNum <= 60 && secondNum < firstNum && backAlive,
    'кнопка: «' + btnText + '», отсчёт ' + firstNum + '→' + secondNum + ' с, после паузы кнопка ожила');
  ok('Счётчик попыток виден под полем', /Осталось попыток|включится через/.test(leftText), leftText);
  await ctx.close();

  /* ---------------- 6. Забаненный гость --------------------------------- */
  ctx = await browser.newContext(ctxOpts); page = await ctx.newPage(); watch(page);
  // в базе поле banned ставит только панель этапа 6, анонимной роли это запрещено,
  // поэтому ответ витрины подменяем: гость настоящий, вход настоящий, банят на лету
  await mock(page, '**/rest/v1/guests_public*', [{ banned: true }]);
  await page.goto(BASE);
  await page.click('#go-login');
  await page.fill('#log-nick', nickA);
  await typePin(page, '#log-pin', pinA);
  await page.click('#log-go');
  await page.waitForSelector('#s-blocked.is-on', { timeout: 20000 });
  var blockedText = (await page.locator('#s-blocked h2').textContent()).trim();
  await shot(page, '10-vhod-zakryt.png');
  var savedAfterBan = await page.evaluate(function () { return localStorage.getItem('svadba.guest'); });
  await page.click('#blocked-home');
  await page.waitForSelector('#s-start.is-on');
  ok('6. Забаненный гость видит «Вход закрыт»',
    blockedText === 'Вход закрыт' && !savedAfterBan,
    'кнопка «На главную» возвращает на старт, сеанс не сохранён');

  // и второй путь: сама база ответила «banned»
  await ctx.close();
  ctx = await browser.newContext(ctxOpts); page = await ctx.newPage(); watch(page);
  await mock(page, '**/rest/v1/rpc/check_pin', { ok: false, error: 'banned' });
  await page.goto(BASE);
  await page.click('#go-login');
  await page.fill('#log-nick', nickA);
  await typePin(page, '#log-pin', pinA);
  await page.click('#log-go');
  await page.waitForSelector('#s-blocked.is-on', { timeout: 20000 });
  ok('6б. Ответ базы «banned» тоже ведёт на «Вход закрыт»', true, '');
  await ctx.close();

  /* ---------------- 9. Своё фото: поворот, щипок, обрезка --------------- */
  ctx = await browser.newContext(ctxOpts); page = await ctx.newPage(); watch(page);
  await page.goto(BASE);

  // делаем настоящий JPEG 600×400 руками браузера и помечаем его как снимок,
  // повёрнутый на бок, — ровно так приходят фотографии с айфона
  var raw = await page.evaluate(async function () {
    var c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    var x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 400);
    x.fillStyle = '#000'; x.fillRect(0, 0, 600, 60);
    x.fillStyle = '#555'; x.fillRect(0, 340, 600, 60);
    x.fillStyle = '#000'; x.font = '90px sans-serif'; x.fillText('ВЕРХ', 150, 240);
    var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.9); });
    var buf = await blob.arrayBuffer();
    return Array.from(new Uint8Array(buf));
  });
  var jpeg = injectExif(Buffer.from(raw), 6);
  fs.writeFileSync(path.join(SHOTS, 'ishodnik-s-povorotom.jpg'), jpeg);

  // тяжёлый снимок с другим поворотом: проверяем, что он ужимается и не валит память
  var bigRaw = await page.evaluate(async function () {
    var c = document.createElement('canvas');
    c.width = 3000; c.height = 2000;
    var x = c.getContext('2d');
    x.fillStyle = '#ccc'; x.fillRect(0, 0, 3000, 2000);
    x.fillStyle = '#000'; x.fillRect(0, 0, 3000, 200);
    var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.8); });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  var bigJpeg = injectExif(Buffer.from(bigRaw), 8);
  await page.click('#go-reg');
  await page.fill('#reg-nick', 'проба-' + rnd());
  await page.fill('#reg-word', 'любовь');
  await typePin(page, '#reg-pin', '1234');
  await page.click('#reg-next');
  await page.waitForSelector('#s-avatar.is-on', { timeout: 15000 });
  await page.setInputFiles('#file-input', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: bigJpeg });
  await page.waitForSelector('#s-crop.is-on', { timeout: 20000 });
  await page.waitForTimeout(600);
  var bigSize = await page.evaluate(function () { return { w: crop.iw, h: crop.ih }; });
  ok('Тяжёлый снимок 3000×2000 ужимается и разворачивается (→ 1067×1600)',
    bigSize.w === 1067 && bigSize.h === 1600, bigSize.w + '×' + bigSize.h);
  await page.click('#crop-cancel');
  await page.waitForSelector('#s-avatar.is-on');
  await page.click('[data-goto="s-reg"]');
  await page.click('[data-goto="s-start"]');

  var nickB = 'тест-' + rnd();
  await page.click('#go-reg');
  await page.fill('#reg-nick', nickB);
  await page.fill('#reg-word', 'ЛюБоВь');
  await typePin(page, '#reg-pin', '7391');
  await page.click('#reg-next');
  await page.waitForSelector('#s-avatar.is-on', { timeout: 15000 });

  await page.setInputFiles('#file-input', { name: 'iphone.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await page.waitForSelector('#s-crop.is-on', { timeout: 15000 });
  await page.waitForTimeout(400);
  var size = await page.evaluate(function () { return { w: crop.iw, h: crop.ih, s: crop.s }; });
  await shot(page, '11-podgonka-foto.png');
  ok('Снимок развёрнут по метаданным съёмки (600×400 → 400×600)',
    size.w === 400 && size.h === 600, size.w + '×' + size.h);

  // щипок двумя пальцами
  var grew = await page.evaluate(function () {
    var stage = document.getElementById('crop-stage');
    var r = stage.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    function ev(type, pts) {
      var touches = pts.map(function (p, i) {
        return new Touch({ identifier: i, target: stage, clientX: p[0], clientY: p[1] });
      });
      stage.dispatchEvent(new TouchEvent(type, {
        touches: touches, targetTouches: touches, changedTouches: touches,
        bubbles: true, cancelable: true
      }));
    }
    var was = crop.s;
    ev('touchstart', [[cx - 30, cy], [cx + 30, cy]]);
    ev('touchmove', [[cx - 90, cy], [cx + 90, cy]]);
    ev('touchend', []);
    return { was: was, now: crop.s };
  });
  ok('Щипок приближает снимок', grew.now > grew.was * 1.5,
    grew.was.toFixed(3) + ' → ' + grew.now.toFixed(3));

  // перетаскивание пальцем
  var moved = await page.evaluate(function () {
    var stage = document.getElementById('crop-stage');
    var r = stage.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    function ev(type, pts) {
      var touches = pts.map(function (p, i) {
        return new Touch({ identifier: i, target: stage, clientX: p[0], clientY: p[1] });
      });
      stage.dispatchEvent(new TouchEvent(type, {
        touches: touches, targetTouches: touches, changedTouches: touches,
        bubbles: true, cancelable: true
      }));
    }
    var was = crop.ty;
    ev('touchstart', [[cx, cy]]);
    ev('touchmove', [[cx, cy - 40]]);
    ev('touchend', []);
    return { was: was, now: crop.ty };
  });
  ok('Снимок двигается пальцем', moved.now !== moved.was,
    'сдвиг по вертикали ' + (moved.now - moved.was).toFixed(1) + ' точек');

  await page.click('#crop-done');
  await page.waitForSelector('#s-avatar.is-on', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, '12-avatar-svoyo-foto.png');

  await page.click('#reg-finish');
  await page.waitForSelector('#s-feed.is-on', { timeout: 30000 });
  madeGuests.push(nickB);
  var rowB = await (await db('guests_public?select=*&nick=eq.' + encodeURIComponent(nickB))).json();
  var value = rowB[0] && rowB[0].avatar_value;
  var got = value ? await fetch(SUPA + '/storage/v1/object/public/avatars/' + value) : null;
  var bytes = got && got.ok ? Buffer.from(await got.arrayBuffer()) : null;
  var dim = bytes ? jpegSize(bytes) : null;
  await shot(page, '13-lenta-so-svoim-foto.png');
  ok('9. Своё фото обрезано в квадрат 400×400 и лежит в бакете avatars',
    rowB[0] && rowB[0].avatar_kind === 'custom' && dim && dim.w === 400 && dim.h === 400,
    value + ', ' + (dim ? dim.w + '×' + dim.h : 'нет файла') + ', ' + (bytes ? Math.round(bytes.length / 1024) + ' КБ' : ''));

  await ctx.close();
  await browser.close();
  if (server) server.close();

  /* ---------------- итог ------------------------------------------------ */
  console.log('\n================ ИТОГ ================');
  var bad = results.filter(function (r) { return !r.pass; });
  results.forEach(function (r) { console.log((r.pass ? '[ да  ] ' : '[ НЕТ ] ') + r.name); });
  console.log('Проверок: ' + results.length + ', не прошло: ' + bad.length);
  console.log('Созданы тестовые гости: ' + madeGuests.join(', '));
  console.log('Скриншоты: ' + SHOTS);
  process.exit(bad.length ? 1 : 0);
}

main().catch(function (e) {
  console.error('СРЫВ ПРОВЕРКИ:', e);
  process.exit(2);
});
