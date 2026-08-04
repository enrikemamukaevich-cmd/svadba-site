/* ============================================================================
   Проверки этапа 4 (загрузка фото) через Playwright.
   Запуск:  set NODE_PATH=<папка с playwright>\node_modules && node tests/check-etap4.cjs
   Скриншоты складываются в tests/shots4.

   Исходники берутся из tests/photos-src — их готовит tests/make-photos.cjs.
   Прогон оставляет в базе настоящие записи и файлы: удалять их публичным
   ключом нельзя, чистятся они одним заходом перед свадьбой вместе с папкой
   test/. Все свои файлы кладём в боевую папку feed/, тестовую не трогаем.
   ============================================================================ */

var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');
var { startServer } = require('./serve.cjs');
var { loadGuest } = require('./guest.cjs');

var ROOT = path.resolve(__dirname, '..');
var SHOTS = path.join(__dirname, 'shots4');
var SRC = path.join(__dirname, 'photos-src');
var SMALL = path.join(__dirname, 'photos');       // лёгкие превью, для счётных проверок
var PORT = 8125;
var BASE = 'http://127.0.0.1:' + PORT + '/';

var SUPA = 'https://hwnmqcvvdlfqscoufyki.supabase.co';
var KEY = 'sb_publishable_UQtVcMc-DoTEFFvDKE0mxQ_PV5nCSnn';

// тот же гость, что и в проверках этапа 3; данные в tests/guest.local.json
var ME = loadGuest();

var NORMAL = '2026-08-06T18:00:00+03:00';        // обычный режим, окно открыто

var results = [];
var uploaded = [];                                // что этот прогон положил в бакет

function ok(name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail || '' });
  console.log((pass ? '  ДА  ' : '  НЕТ ') + name + (detail ? ' — ' + detail : ''));
}

function db(q, opts) {
  var o = opts || {};
  o.headers = Object.assign(
    { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    o.headers || {}
  );
  return fetch(SUPA + '/rest/v1/' + q, o);
}

function when(iso) { return BASE + '?now=' + encodeURIComponent(iso); }

// Ровно то же правило, по которому размеры читает сама лента
var SIZE_RE = /-(\d{2,5})x(\d{2,5})\.[a-z0-9]+$/i;
function sizeOf(p) {
  var m = SIZE_RE.exec(p || '');
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
}

function seed(page) {
  return page.addInitScript(function (g) {
    try { localStorage.setItem('svadba.guest', JSON.stringify(g)); } catch (e) {}
  }, ME);
}

function feedReady(page) {
  return page.waitForFunction(function () {
    var c = document.getElementById('feed-count');
    return c && /Всего фото: \d+/.test(c.textContent);
  }, null, { timeout: 30000 });
}

async function snap(page, name) {
  await page.waitForFunction(function () {
    return Array.prototype.slice.call(document.images).every(function (i) {
      var r = i.getBoundingClientRect();
      var near = r.width > 0 && r.bottom > -200 && r.top < window.innerHeight + 200;
      return !near || i.complete;
    });
  }, null, { timeout: 20000 }).catch(function () {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

// Мои снимки в боевой папке — по ним считаем, что прибавилось за прогон
async function mineInFeed() {
  var r = await db('photos?select=id,preview_path,created_at&guest_id=eq.' + ME.id +
                   '&preview_path=like.feed/*&order=created_at.desc');
  return await r.json();
}

function openUploadScreen(page) {
  return page.click('#btn-plus').then(function () {
    return page.waitForSelector('#s-upload.is-on', { timeout: 10000 });
  });
}

// Ждём, пока очередь отработает и покажет итог
function queueDone(page, ms) {
  return page.waitForSelector('#up-done:not([hidden])', { timeout: ms || 120000 });
}

/* --------------------------------------------------------------------------
   Основной ход
   -------------------------------------------------------------------------- */

async function main() {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  if (!fs.existsSync(SRC)) {
    console.error('Нет исходников. Сначала: node tests/make-photos.cjs');
    process.exit(2);
  }

  var srcFiles = fs.readdirSync(SRC).map(function (f) { return path.join(SRC, f); });
  var plain = srcFiles.filter(function (f) { return /foto-/.test(f); });
  var turned = srcFiles.find(function (f) { return /povorot-6/.test(f); });
  var hard = srcFiles.find(function (f) { return /uzor-/.test(f); });

  var server = await startServer(ROOT, PORT);
  var browser = await chromium.launch();
  var ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    locale: 'ru-RU'
  });

  var was = await mineInFeed();
  console.log('\nДо прогона у гостя ' + ME.nick + ' в папке feed/: ' + was.length + ' снимков\n');

  var page = await ctx.newPage();
  page.on('pageerror', function (e) { console.log('  !! ошибка на странице: ' + e.message); });
  await seed(page);

  /* === 1. Экран загрузки открывается по плюсу ============================ */
  await page.goto(when(NORMAL));
  await feedReady(page);
  await openUploadScreen(page);

  var dropTitle = (await page.textContent('.drop-title')).trim();
  var dropSub = (await page.textContent('.drop-sub')).trim();
  var dashed = await page.$eval('.drop', function (n) {
    return getComputedStyle(n).borderStyle;
  });
  var hasIcon = await page.$eval('.drop-icon', function (n) { return !!n; });
  ok('1. Экран загрузки: пунктирная область, значок камеры, надписи',
     dropTitle === 'Выбрать из галереи' && dropSub === 'до 10 фото за раз' &&
     /dashed/.test(dashed) && hasIcon,
     dropTitle + ' / ' + dropSub + ' / рамка ' + dashed);
  await snap(page, '01-ekran-vybora.png');

  /* === 2. Один снимок появляется в ленте ================================= */
  await page.setInputFiles('#up-input', [plain[0]]);
  await queueDone(page);

  var res1 = (await page.textContent('#up-result')).trim();
  var one = await mineInFeed();
  var added1 = one.filter(function (p) {
    return !was.some(function (w) { return w.id === p.id; });
  });
  added1.forEach(function (p) { uploaded.push(p.preview_path); });

  ok('2. Один снимок загружается и попадает в базу', added1.length === 1,
     res1 + ' → ' + (added1[0] && added1[0].preview_path));

  // и сразу стоит в ленте, без её перезагрузки
  await page.click('#up-tofeed');
  await page.waitForSelector('#s-feed.is-on', { timeout: 10000 });
  var top1 = await page.$eval('#feed .card:not(.is-skeleton) .card-shot img',
    function (i) { return decodeURIComponent(i.getAttribute('src').split('/photos/')[1]); });
  ok('2б. Снимок стоит первым в ленте сразу после отправки',
     added1.length === 1 && top1 === added1[0].preview_path, top1);

  /* === 3. Десять снимков — десять отдельных карточек ===================== */
  var ten = plain.slice(0, 9).concat([turned]);      // ровно десять, один с поворотом
  var before10 = await mineInFeed();
  var cardsBefore = await page.$$eval('#feed .card:not(.is-skeleton)', function (n) { return n.length; });

  await openUploadScreen(page);

  // притормаживаем хранилище, чтобы успеть снять экран отправки
  await page.route('**/storage/v1/object/photos/**', async function (route) {
    await new Promise(function (r) { setTimeout(r, 700); });
    route.continue();
  });

  await page.setInputFiles('#up-input', ten);

  // снимок экрана прямо во время отправки
  await page.waitForFunction(function () {
    var t = document.getElementById('up-thumbs');
    return t && t.children.length === 10 &&
           /Отправляется [2-9] из 10/.test(document.getElementById('up-line').textContent);
  }, null, { timeout: 60000 }).catch(function () {});
  var lineMid = (await page.textContent('#up-line')).trim();
  var thumbs = await page.$$eval('.up-thumb', function (n) { return n.length; });
  var warn = (await page.textContent('.up-warn')).trim();
  var barWidth = await page.$eval('#up-fill', function (n) { return n.style.width; });
  ok('3. Во время отправки: строка «Отправляется N из 10», полоса, превью, предупреждение',
     /^Отправляется \d+ из 10$/.test(lineMid) && thumbs === 10 &&
     warn === 'Не закрывайте страницу, пока идёт отправка' && barWidth !== '0',
     lineMid + ', превью ' + thumbs + ', полоса ' + barWidth);
  await page.screenshot({ path: path.join(SHOTS, '02-ekran-otpravki.png') });

  await queueDone(page, 180000);
  await page.unroute('**/storage/v1/object/photos/**');

  var after10 = await mineInFeed();
  var added10 = after10.filter(function (p) {
    return !before10.some(function (w) { return w.id === p.id; });
  });
  added10.forEach(function (p) { uploaded.push(p.preview_path); });
  ok('3б. Десять снимков дали десять отдельных записей', added10.length === 10,
     'прибавилось ' + added10.length + ', итог: ' + (await page.textContent('#up-result')).trim());

  await page.click('#up-tofeed');
  await page.waitForSelector('#s-feed.is-on', { timeout: 10000 });
  var cardsAfter = await page.$$eval('#feed .card:not(.is-skeleton)', function (n) { return n.length; });
  ok('3в. В ленте прибавилось ровно десять карточек, лента не перезагружалась',
     cardsAfter - cardsBefore === 10, 'было ' + cardsBefore + ', стало ' + cardsAfter);
  await snap(page, '03-rezultat-v-lente.png');

  /* === 3г. Снимок с пометкой поворота ==================================== */
  /* Исходник широкий — 3600×2025, — но помечен поворотом на 90°, ровно так
     айфон отдаёт кадры, снятые «стоя». Отправляем его отдельно и в одиночку:
     если поворот учтён, превью выйдет вертикальным 810×1440, если пропущен —
     горизонтальным 1440×810. Третьего не дано, потому проверка однозначна. */
  var beforeTurn = await mineInFeed();
  await openUploadScreen(page);
  await page.setInputFiles('#up-input', [turned]);
  await queueDone(page);
  var afterTurn = await mineInFeed();
  var addedTurn = afterTurn.filter(function (p) {
    return !beforeTurn.some(function (w) { return w.id === p.id; });
  });
  addedTurn.forEach(function (p) { uploaded.push(p.preview_path); });
  var turnSize = addedTurn.length === 1 ? sizeOf(addedTurn[0].preview_path) : null;
  ok('3г. Снимок с пометкой поворота развёрнут: 3600×2025 → 810×1440',
     !!turnSize && turnSize.w === 810 && turnSize.h === 1440,
     turnSize ? (addedTurn[0].preview_path.split('/').pop() + ' — ' + turnSize.w + '×' + turnSize.h +
                 (turnSize.w > turnSize.h ? ' (лёг набок!)' : '')) : 'запись не появилась');
  var turnedPath = addedTurn.length === 1 ? addedTurn[0].preview_path : null;
  await page.click('#up-tofeed');
  await page.waitForSelector('#s-feed.is-on', { timeout: 10000 });

  /* === 4. Одиннадцатый отсекается ======================================== */
  /* Сеть тут подменяем: проверяем счёт, а не отправку, и незачем ради этого
     класть в базу ещё десять записей — чистить их потом руками. */
  var smalls = fs.readdirSync(SMALL).slice(0, 11).map(function (f) { return path.join(SMALL, f); });
  var before11 = await mineInFeed();

  var fakeCors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
    'access-control-expose-headers': 'content-range',
    'content-type': 'application/json'
  };
  await page.route('**/storage/v1/object/photos/**', function (route) {
    if (route.request().method() !== 'POST') return route.continue();
    route.fulfill({ status: 200, headers: fakeCors, body: '{"Key":"photos/feed/пусто.jpg"}' });
  });
  await page.route('**/rest/v1/photos*', function (route) {
    if (route.request().method() !== 'POST') return route.continue();
    route.fulfill({
      status: 201, headers: fakeCors,
      body: JSON.stringify([{
        id: '00000000-0000-0000-0000-0000000000' + Math.floor(10 + Math.random() * 89),
        guest_id: ME.id, preview_path: 'feed/пусто-100x100.jpg',
        created_at: new Date().toISOString()
      }])
    });
  });

  await openUploadScreen(page);
  await page.setInputFiles('#up-input', smalls);
  await page.waitForSelector('#err-upload.is-on', { timeout: 15000 });
  var msg11 = (await page.textContent('#err-upload')).trim();
  var queued11 = await page.$$eval('.up-thumb', function (n) { return n.length; });
  await queueDone(page, 180000);
  var res11 = (await page.textContent('#up-result')).trim();
  var after11 = await mineInFeed();
  ok('4. Из одиннадцати снимков в очередь попало десять, лишний отклонён с объяснением',
     /Выбрано 11 фото/.test(msg11) && /до 10/.test(msg11) && queued11 === 10 &&
     after11.length === before11.length,
     msg11 + ' | в очереди ' + queued11 + ' | ' + res11);
  await snap(page, '04-odinnadcatyj-otklonen.png');

  await page.unroute('**/storage/v1/object/photos/**');
  await page.unroute('**/rest/v1/photos*');
  await page.click('#up-tofeed');
  await page.waitForSelector('#s-feed.is-on', { timeout: 10000 });
  await page.reload();
  await feedReady(page);

  /* === 5. Слишком большой файл =========================================== */
  var bigPath = path.join(SHOTS, 'tyazholyj-26mb.jpg');
  fs.writeFileSync(bigPath, Buffer.alloc(26 * 1024 * 1024, 0x20));
  await openUploadScreen(page);
  await page.setInputFiles('#up-input', [bigPath]);
  await page.waitForSelector('#err-upload.is-on', { timeout: 15000 });
  var msgBig = (await page.textContent('#err-upload')).trim();
  var runShown = await page.isVisible('#up-run');
  ok('5. Файл тяжелее 25 МБ отклоняется сообщением «Файл слишком большой»',
     /Файл слишком большой/.test(msgBig) && !runShown, msgBig);
  fs.unlinkSync(bigPath);

  /* === 6. Нечитаемый файл не обрывает очередь ============================ */
  var heicPath = path.join(SHOTS, 'IMG_0001.HEIC');
  var junk = Buffer.alloc(300000);
  for (var z = 0; z < junk.length; z++) junk[z] = (Math.random() * 256) | 0;
  fs.writeFileSync(heicPath, junk);

  var beforeHeic = await mineInFeed();
  await page.reload();
  await feedReady(page);
  await openUploadScreen(page);
  await page.setInputFiles('#up-input', [heicPath, plain[1]]);
  await queueDone(page, 120000);
  var heicMsg = (await page.textContent('#up-result')).trim();
  var afterHeic = await mineInFeed();
  var addedHeic = afterHeic.filter(function (p) {
    return !beforeHeic.some(function (w) { return w.id === p.id; });
  });
  addedHeic.forEach(function (p) { uploaded.push(p.preview_path); });
  ok('6. Нечитаемый снимок помечен, очередь пошла дальше и второй файл ушёл',
     /Не удалось прочитать 1 фото/.test(heicMsg) && addedHeic.length === 1, heicMsg);
  await snap(page, '05-nechitaemyj-fajl.png');
  fs.unlinkSync(heicPath);
  await page.click('#up-tofeed');
  await page.waitForSelector('#s-feed.is-on', { timeout: 10000 });

  /* === 7. Обрыв сети: файл повторяется, а не теряется ==================== */
  // роняем две первые попытки, третью пропускаем
  var attempts = 0;
  await page.route('**/storage/v1/object/photos/**', function (route) {
    if (route.request().method() === 'OPTIONS') return route.continue();
    attempts++;
    if (attempts <= 2) return route.abort('connectionfailed');
    route.continue();
  });

  var beforeNet = await mineInFeed();
  await openUploadScreen(page);
  await page.setInputFiles('#up-input', [plain[2]]);
  await queueDone(page, 180000);
  var netMsg = (await page.textContent('#up-result')).trim();
  var afterNet = await mineInFeed();
  var addedNet = afterNet.filter(function (p) {
    return !beforeNet.some(function (w) { return w.id === p.id; });
  });
  addedNet.forEach(function (p) { uploaded.push(p.preview_path); });
  ok('7. Два обрыва сети подряд — снимок дошёл с третьей попытки',
     attempts >= 3 && addedNet.length === 1,
     'попыток отправки: ' + attempts + ', итог: ' + netMsg);
  await page.unroute('**/storage/v1/object/photos/**');
  await page.click('#up-tofeed');
  await page.waitForSelector('#s-feed.is-on', { timeout: 10000 });

  /* === 7б. Сеть лежит совсем: файл помечен, работает кнопка повтора ====== */
  var dead = true;
  await page.route('**/storage/v1/object/photos/**', function (route) {
    if (route.request().method() === 'OPTIONS') return route.continue();
    if (dead) return route.abort('connectionfailed');
    route.continue();
  });

  var beforeRetry = await mineInFeed();
  await openUploadScreen(page);
  await page.setInputFiles('#up-input', [plain[3]]);
  await queueDone(page, 180000);
  var failMsg = (await page.textContent('#up-result')).trim();
  var retryShown = await page.isVisible('#up-retry');
  var warnGone = !(await page.isVisible('#up-warn'));
  var midRetry = await mineInFeed();
  ok('7б. После трёх неудач снимок помечен, показана кнопка повтора',
     /1 фото не отправилось, попробуйте ещё раз/.test(failMsg) && retryShown &&
     midRetry.length === beforeRetry.length,
     failMsg + ' | кнопка повтора: ' + retryShown);
  ok('7г. Когда очередь встала, предупреждение «не закрывайте страницу» убрано',
     warnGone, warnGone ? 'убрано' : 'осталось висеть');
  await snap(page, '06-ne-otpravilos.png');

  dead = false;                                   // сеть вернулась
  await page.click('#up-retry');
  // итог прячется на время новой попытки — дожидаемся именно нового
  await page.waitForSelector('#up-done[hidden]', { timeout: 10000 }).catch(function () {});
  await queueDone(page, 180000);
  var afterRetry = await mineInFeed();
  var addedRetry = afterRetry.filter(function (p) {
    return !beforeRetry.some(function (w) { return w.id === p.id; });
  });
  addedRetry.forEach(function (p) { uploaded.push(p.preview_path); });
  ok('7в. Повтор берёт только несработавший снимок и дожимает его',
     addedRetry.length === 1, (await page.textContent('#up-result')).trim());
  await page.unroute('**/storage/v1/object/photos/**');
  await page.click('#up-tofeed');
  await page.waitForSelector('#s-feed.is-on', { timeout: 10000 });

  /* === 8. Рубильник upload_enabled ======================================= */
  /* Страницу гость открыл, когда приём был включён, а выключили уже потом.
     Настройки подменяем ответом сети — боевую запись в базе не трогаем. */
  var guard = await ctx.newPage();
  guard.on('pageerror', function (e) { console.log('  !! ошибка на странице: ' + e.message); });
  await seed(guard);
  await guard.goto(when(NORMAL));
  await feedReady(guard);

  var plusWasOn = await guard.$eval('#btn-plus', function (b) { return !b.classList.contains('is-off'); });

  // с этого мгновения база отвечает, что приём выключен
  await guard.route('**/rest/v1/settings*', function (route) {
    var cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'access-control-expose-headers': 'content-range',
      'content-type': 'application/json'
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    route.fulfill({
      status: 200, headers: cors,
      body: JSON.stringify([
        { key: 'upload_enabled', value: 'false' },
        { key: 'window_start', value: '2026-08-06T12:00:00+03:00' },
        { key: 'window_end', value: '2026-08-07T12:00:00+03:00' },
        { key: 'readonly_end', value: '2026-08-08T00:00:00+03:00' }
      ])
    });
  });

  var beforeOff = await mineInFeed();
  await guard.click('#btn-plus');                 // кнопка ещё «горячая» — страница открыта раньше
  await guard.waitForSelector('#s-upload.is-on', { timeout: 10000 });
  await guard.waitForSelector('#err-upload.is-on', { timeout: 15000 });
  var offMsg = (await guard.textContent('#err-upload')).trim();
  var pickOff = await guard.$eval('#up-pick', function (b) { return b.disabled; });
  ok('8. Рубильник выключен: экран открылся, но выбор фото закрыт с причиной',
     plusWasOn && /Загрузка сейчас выключена/.test(offMsg) && pickOff,
     'плюс был активен: ' + plusWasOn + ' | ' + offMsg);
  await snap(guard, '07-rubilnik-vyklyuchen.png');

  // и даже если файл всё же подсунуть — отправка не пойдёт
  await guard.evaluate(function () { document.getElementById('up-pick').disabled = false; });
  await guard.setInputFiles('#up-input', [plain[4]]);
  await queueDone(guard, 120000);
  var offResult = (await guard.textContent('#up-result')).trim();
  var afterOff = await mineInFeed();
  ok('8б. Отправка при выключенном рубильнике не проходит и в обход кнопки',
     /Загрузка сейчас выключена/.test(offResult) && afterOff.length === beforeOff.length,
     offResult + ' | записей было ' + beforeOff.length + ', стало ' + afterOff.length);
  await guard.close();

  /* === 9. Вес файлов в хранилище ========================================= */
  var weights = [];
  for (var i = 0; i < uploaded.length; i++) {
    var r = await fetch(SUPA + '/storage/v1/object/public/photos/' + uploaded[i]);
    var buf = Buffer.from(await r.arrayBuffer());
    weights.push({ path: uploaded[i], bytes: buf.length });
  }
  var over = weights.filter(function (w) { return w.bytes > 250 * 1024; });
  var nums = weights.map(function (w) { return w.bytes; }).sort(function (a, b) { return a - b; });
  var mid = nums[Math.floor(nums.length / 2)] || 0;
  ok('9. Каждый файл в хранилище легче 250 КБ',
     weights.length > 0 && over.length === 0,
     'файлов ' + weights.length + ', середина ' + (mid / 1024).toFixed(0) +
     ' КБ, самый тяжёлый ' + (Math.max.apply(null, nums) / 1024).toFixed(0) + ' КБ');

  console.log('\n  Вес первых пяти файлов в хранилище:');
  weights.slice(0, 5).forEach(function (w) {
    console.log('    ' + w.path + '  ' + (w.bytes / 1024).toFixed(1) + ' КБ');
  });
  console.log('');

  /* === 10. Имя файла и настоящие пиксели превью ========================== */
  var mismatch = [];
  for (var j = 0; j < uploaded.length; j++) {
    var want = sizeOf(uploaded[j]);
    if (!want) { mismatch.push(uploaded[j] + ': размеров в имени нет'); continue; }
    var real = await page.evaluate(function (url) {
      return new Promise(function (res) {
        var im = new Image();
        im.onload = function () { res({ w: im.naturalWidth, h: im.naturalHeight }); };
        im.onerror = function () { res(null); };
        im.src = url;
      });
    }, SUPA + '/storage/v1/object/public/photos/' + uploaded[j]);
    if (!real || real.w !== want.w || real.h !== want.h) {
      mismatch.push(uploaded[j] + ': на деле ' + (real ? real.w + '×' + real.h : 'не открылся'));
    }
  }
  ok('10. Размеры в имени совпадают с настоящими пикселями превью',
     uploaded.length > 0 && mismatch.length === 0,
     mismatch.length ? mismatch.join('; ') : 'сверено ' + uploaded.length + ' файлов');

  // длинная сторона не больше 1440 и пропорции сохранены
  var sideBad = uploaded.filter(function (p) {
    var s = sizeOf(p);
    return !s || Math.max(s.w, s.h) > 1440;
  });
  ok('10б. Длинная сторона превью не больше 1440 точек', sideBad.length === 0,
     sideBad.length ? sideBad.join('; ') : 'проверено ' + uploaded.length + ' файлов');

  /* === 11. Лента не прыгает: место под фото занято до его загрузки ======= */
  await page.reload();
  await feedReady(page);
  var jump = await page.evaluate(function () {
    var out = { checked: 0, bad: [] };
    var cards = document.querySelectorAll('#feed .card:not(.is-skeleton)');
    for (var i = 0; i < cards.length; i++) {
      var shot = cards[i].querySelector('.card-shot');
      var img = shot && shot.querySelector('img');
      if (!img) continue;
      var src = decodeURIComponent(img.getAttribute('src') || '');
      var m = /-(\d{2,5})x(\d{2,5})\.[a-z0-9]+$/i.exec(src);
      if (!m) continue;
      out.checked++;
      var want = m[1] + ' / ' + m[2];
      if ((shot.style.aspectRatio || '').replace(/\s+/g, ' ').trim() !== want) {
        out.bad.push(src.split('/').pop() + ': стоит «' + shot.style.aspectRatio + '», ждали «' + want + '»');
      }
    }
    return out;
  });
  ok('11. Место под каждый снимок занято по имени файла — лента не прыгает',
     jump.checked > 0 && jump.bad.length === 0,
     jump.bad.length ? jump.bad.join('; ') : 'проверено карточек ' + jump.checked);

  /* === 12. Вертикальный снимок: не набок и не обрезан ==================== */
  // берём тот самый развёрнутый кадр — он же и самый узкий
  var vertPath = turnedPath || uploaded.find(function (p) {
    var s = sizeOf(p);
    return s && s.h > s.w;
  });
  var vert = await page.evaluate(async function (file) {
    var img = document.querySelector('#feed .card-shot img[src*="' + file + '"]');
    if (!img) return null;
    var box = img.parentElement;
    box.scrollIntoView({ block: 'center' });
    if (!img.complete || !img.naturalWidth) {
      await new Promise(function (res) {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
        setTimeout(res, 15000);
      });
    }
    var br = box.getBoundingClientRect();
    var ir = img.getBoundingClientRect();
    return {
      nw: img.naturalWidth, nh: img.naturalHeight,
      nat: img.naturalWidth / img.naturalHeight,
      box: br.width / br.height,
      fillH: ir.height / br.height,
      fillW: ir.width / br.width
    };
  }, vertPath ? vertPath.split('/').pop() : '');

  ok('12. Вертикальный снимок стоит правильной стороной и не обрезан',
     !!vert && vert.nh > vert.nw && Math.abs(vert.box - vert.nat) < 0.02 &&
     vert.fillH > 0.98 && vert.fillW > 0.98,
     vert ? (vertPath.split('/').pop() + ': ' + vert.nw + '×' + vert.nh +
             ', пропорции ' + vert.nat.toFixed(3) + ' против рамки ' + vert.box.toFixed(3) +
             ', видно по высоте ' + (vert.fillH * 100).toFixed(0) + '%')
          : 'вертикальный снимок не найден');
  await snap(page, '08-vertikalnoe-foto.png');

  /* --- итог --- */
  await browser.close();
  server.close();

  var bad = results.filter(function (r) { return !r.pass; });
  console.log('\n=================================');
  console.log('Пройдено ' + (results.length - bad.length) + ' из ' + results.length);
  if (bad.length) {
    console.log('Не прошли:');
    bad.forEach(function (b) { console.log('  - ' + b.name + (b.detail ? ' — ' + b.detail : '')); });
  }
  console.log('Отправлено за прогон: ' + uploaded.length + ' снимков в feed/');
  console.log('Скриншоты: ' + SHOTS);
  process.exit(bad.length ? 1 : 0);
}

main().catch(function (e) {
  console.error('Проверки сорвались: ' + (e && e.stack || e));
  process.exit(2);
});
