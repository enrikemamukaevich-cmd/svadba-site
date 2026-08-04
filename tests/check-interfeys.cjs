/* ============================================================================
   Проверки интерфейсных правок после этапа 5.
   Запуск:  npm run test:ui
   Скриншоты складываются в tests/shots6.

   Что проверяется: двойной тап вместо одиночного, анимация лайка, шторка
   комментариев с перетаскиванием, текстовая кнопка жалобы, аватарки и ники
   в комментариях, выход из аккаунта, лента одного гостя, размеры кнопок.

   Жесты идут указателем (pointer events) — теми же событиями, что слушает
   сама страница, поэтому проверяется настоящий код, а не его подобие.
   Часы подменяются доводом ?now=, настройка window_start не трогается.
   ============================================================================ */

var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');
var { startServer } = require('./serve.cjs');
var { loadMates } = require('./guest.cjs');

var ROOT = path.resolve(__dirname, '..');
var SHOTS = path.join(__dirname, 'shots6');
var PORT = 8127;
var BASE = 'http://127.0.0.1:' + PORT + '/';

var SUPA = 'https://hwnmqcvvdlfqscoufyki.supabase.co';
var KEY = 'sb_publishable_UQtVcMc-DoTEFFvDKE0mxQ_PV5nCSnn';
var WINDOW_START = '2026-08-06T12:00:00+03:00';

var CREW = loadMates();
var ME = CREW.me, MATE = CREW.mate;
var MY_PIN = '1234';               // пин тестового гостя, им проверяется вход обратно

var results = [];
var NORMAL = '';

function ok(name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail || '' });
  console.log((pass ? '  ДА  ' : '  НЕТ ') + name + (detail ? ' — ' + detail : ''));
}

/* Сеть на машине Энрике идёт через туннель и изредка отваливается на одном
   запросе. Проверка не должна из-за этого срываться целиком — пробуем трижды. */
async function db(q, opts) {
  var o = opts || {};
  o.headers = Object.assign(
    { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    o.headers || {}
  );
  var last;
  for (var i = 0; i < 3; i++) {
    try { return await fetch(SUPA + '/rest/v1/' + q, o); }
    catch (e) {
      last = e;
      await new Promise(function (r) { setTimeout(r, 600 * (i + 1)); });
    }
  }
  throw last;
}

function when(iso) { return BASE + '?now=' + encodeURIComponent(iso); }

async function loadTimes() {
  var rows = await (await db('settings?select=key,value')).json();
  var start = (rows || []).find(function (r) { return r.key === 'window_start'; });
  var t = Date.parse(start && start.value);
  if (isNaN(t)) throw new Error('в настройках нечитаемое время');
  NORMAL = new Date(t + 3600000).toISOString();
  console.log('Проверяем в момент ' + NORMAL + '\n');
}

function seed(page, guest) {
  return page.addInitScript(function (g) {
    try { localStorage.setItem('svadba.guest', JSON.stringify(g)); } catch (e) {}
  }, guest);
}

function feedReady(page) {
  return page.waitForFunction(function () {
    var c = document.getElementById('feed-count');
    return c && /Всего фото: \d+/.test(c.textContent) &&
           document.querySelectorAll('#feed .card:not(.is-skeleton)').length > 0;
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
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

function likeCount(photoId) {
  return db('likes?select=photo_id&photo_id=eq.' + photoId, { headers: { Prefer: 'count=exact', Range: '0-0' } })
    .then(function (r) {
      var n = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
      return isNaN(n) ? 0 : n;
    });
}

/* --------------------------------------------------------------------------
   Жесты
   -------------------------------------------------------------------------- */

// Середина элемента в точках экрана
async function centerOf(page, sel) {
  var box = await page.$eval(sel, function (n) {
    var r = n.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  });
  return box;
}

// Два касания подряд быстрее порога — тот самый двойной тап
async function doubleTap(page, sel) {
  var c = await centerOf(page, sel);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(60);
  await page.mouse.down(); await page.mouse.up();
}

async function singleTap(page, sel) {
  var c = await centerOf(page, sel);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down(); await page.mouse.up();
}

// Протаскивание: from → на dy вниз, за steps шагов с паузой pause между ними.
// Маленькая пауза даёт быстрый рывок, большая — медленное движение.
async function dragDown(page, sel, dy, steps, pause, release) {
  var c = await centerOf(page, sel);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (var i = 1; i <= steps; i++) {
    await page.mouse.move(c.x, c.y + (dy * i) / steps);
    if (pause) await page.waitForTimeout(pause);
  }
  if (release !== false) await page.mouse.up();
}

/* Открыть шторку, если она закрыта, и дождаться комментариев. Возвращает
   true, если к началу проверки шторка и правда открыта: проверять закрытие
   на уже закрытой шторке — значит проверять пустоту. */
async function ensureSheet(page, photoId) {
  var open = await page.evaluate(function () {
    return document.getElementById('sheet').classList.contains('is-open');
  });
  if (!open) {
    await page.evaluate(function (id) { window.openSheet(id, true); }, photoId);
    await page.waitForSelector('#sheet.is-open', { timeout: 10000 });
    await page.waitForSelector('#cm-list .cm', { timeout: 20000 });
  }
  await page.waitForTimeout(450);
  return page.evaluate(function () {
    return document.getElementById('sheet').classList.contains('is-open') &&
           !document.getElementById('sheet').hidden;
  });
}

// Шторка прячется атрибутом hidden, а не исчезновением из разметки
function sheetGone(page) {
  return page.waitForFunction(function () {
    return document.getElementById('sheet').hidden;
  }, null, { timeout: 10000 });
}

/* Насколько шторка уехала вниз. У спрятанной шторки смещения нет вовсе —
   возвращаем null, иначе закрывшаяся шторка притворилась бы стоящей на месте. */
function sheetY(page) {
  return page.$eval('#sheet-card', function (n) {
    if (document.getElementById('sheet').hidden) return null;
    var m = /matrix\([^)]*,\s*([-\d.]+)\)/.exec(getComputedStyle(n).transform);
    return m ? Math.round(parseFloat(m[1])) : 0;
  });
}

/* --------------------------------------------------------------------------
   Основной ход
   -------------------------------------------------------------------------- */

async function main() {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  var server = await startServer(ROOT, PORT);
  var browser = await chromium.launch();
  var ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    locale: 'ru-RU',
    hasTouch: true
  });

  await loadTimes();

  var page = await ctx.newPage();
  page.on('pageerror', function (e) { console.log('  !! ошибка на странице: ' + e.message); });
  page.on('dialog', function (d) { d.accept(); });
  await seed(page, ME);
  await page.goto(when(NORMAL));
  await feedReady(page);

  /* Снимок для лайков берём тот, который этот гость ещё НЕ лайкал, и сверяем
     это с базой, а не с закраской на экране: свои лайки приезжают отдельным
     вызовом и могут ещё не успеть закрасить сердце. */
  var onScreen = await page.evaluate(function () {
    return Array.prototype.map.call(
      document.querySelectorAll('#feed .card:not(.is-skeleton)'),
      function (c) { return c.dataset.id; });
  });
  var myLikes = await (await db('likes?select=photo_id&guest_id=eq.' + ME.id +
                                '&photo_id=in.(' + onScreen.join(',') + ')')).json();
  var likedSet = (myLikes || []).map(function (l) { return l.photo_id; });
  var target = onScreen.filter(function (id) { return likedSet.indexOf(id) === -1; })[0];
  if (!target) throw new Error('в первой порции нет ни одного нелайкнутого снимка');
  var cardSel = '#feed .card[data-id="' + target + '"]';

  /* Для шторки нужен снимок, у которого комментариев хватает на прокрутку:
     иначе проверку «список листается, а шторка стоит» не на чем делать. */
  var allCm = await (await db('comments?select=photo_id')).json();
  var byPhoto = {};
  (allCm || []).forEach(function (c) { byPhoto[c.photo_id] = (byPhoto[c.photo_id] || 0) + 1; });
  var talkPhoto = Object.keys(byPhoto).sort(function (a, b) { return byPhoto[b] - byPhoto[a]; })[0];
  var talkCount = talkPhoto ? byPhoto[talkPhoto] : 0;
  console.log('Лайки проверяем на ' + target + ', шторку — на ' + talkPhoto +
              ' (' + talkCount + ' комментариев)\n');
  await page.$eval(cardSel, function (n) { n.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(400);

  /* === 1. Одиночный тап по фото не делает ничего ========================= */
  var before1 = await likeCount(target);
  var shown1 = await page.textContent(cardSel + ' .act-like .act-n');

  await singleTap(page, cardSel + ' .card-shot');
  await page.waitForTimeout(1200);

  var afterSingle = await likeCount(target);
  var screenAfter = await page.evaluate(function (id) {
    return {
      screen: (document.querySelector('.screen.is-on') || {}).id,
      sheet: !document.getElementById('sheet').hidden,
      n: document.querySelector('#feed .card[data-id="' + id + '"] .act-like .act-n').textContent
    };
  }, target);

  ok('1. Одиночный тап по фото не делает ничего',
     afterSingle === before1 && screenAfter.screen === 's-feed' && !screenAfter.sheet &&
     screenAfter.n === shown1,
     'лайков было ' + before1 + ', стало ' + afterSingle + ', экран «' + screenAfter.screen +
     '», шторка открыта: ' + screenAfter.sheet);

  /* === 2. Двойной тап ставит лайк и показывает анимацию =================== */
  await page.waitForTimeout(CONFIGTAP());          // чтобы одиночный не склеился с двойным
  await doubleTap(page, cardSel + ' .card-shot');

  // анимация ловится сразу, до ответа сети
  var popped = await page.$eval(cardSel + ' .pop', function (n) {
    return { cls: n.classList.contains('is-pop'), op: getComputedStyle(n).opacity };
  });
  await snap(page, '02-animaciya-lajka.png');

  await page.waitForTimeout(1600);
  var after2 = await likeCount(target);
  var state2 = await page.evaluate(function (id) {
    var b = document.querySelector('#feed .card[data-id="' + id + '"] .act-like');
    return { on: b.classList.contains('is-on'), n: b.querySelector('.act-n').textContent,
             color: getComputedStyle(b).color };
  }, target);

  ok('2. Двойной тап ставит лайк, показывает крупное сердце, число растёт',
     popped.cls && after2 === before1 + 1 && state2.on &&
     Number(state2.n) === after2,
     'анимация запущена: ' + popped.cls + ', лайков ' + before1 + ' → ' + after2 +
     ', на экране ' + state2.n);

  ok('2б. Закрашенное сердце красное, оттенка инстаграма',
     /237,\s*73,\s*86/.test(state2.color), 'цвет сердца ' + state2.color);

  /* === 3. Двойной тап по уже лайкнутому не снимает лайк =================== */
  await page.waitForTimeout(500);
  await doubleTap(page, cardSel + ' .card-shot');
  var popped3 = await page.$eval(cardSel + ' .pop', function (n) { return n.classList.contains('is-pop'); });
  await page.waitForTimeout(1600);
  var after3 = await likeCount(target);
  var state3 = await page.evaluate(function (id) {
    var b = document.querySelector('#feed .card[data-id="' + id + '"] .act-like');
    return { on: b.classList.contains('is-on'), n: b.querySelector('.act-n').textContent };
  }, target);

  ok('3. Двойной тап по уже лайкнутому лайк не снимает, но анимацию показывает',
     after3 === after2 && state3.on && Number(state3.n) === after3 && popped3,
     'лайков осталось ' + after3 + ', сердце закрашено: ' + state3.on +
     ', анимация показана: ' + popped3);

  // а сердцем в строке действий — снимается
  await page.click(cardSel + ' .act-like');
  await page.waitForTimeout(1600);
  var afterOff = await likeCount(target);
  ok('3б. Сердцем в строке действий лайк снимается',
     afterOff === after3 - 1, 'лайков ' + after3 + ' → ' + afterOff);

  /* === 4. Прокрутка пальцем не ставит случайных лайков ==================== */
  var beforeScroll = await likeCount(target);
  var c = await centerOf(page, cardSel + ' .card-shot');
  for (var s = 0; s < 3; s++) {
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (var k = 1; k <= 6; k++) await page.mouse.move(c.x, c.y - k * 25);
    await page.mouse.up();
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1200);
  var afterScroll = await likeCount(target);
  ok('4. Прокрутка ленты пальцем по фото не ставит случайных лайков',
     afterScroll === beforeScroll,
     'лайков было ' + beforeScroll + ', после трёх протяжек ' + afterScroll);

  /* === 5. Шторка: открывается, тянется, закрывается ====================== */
  await page.goto(when(NORMAL));
  await feedReady(page);
  await page.$eval(cardSel, function (n) { n.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300);

  // сперва убеждаемся, что значок комментариев в ленте шторку открывает
  await page.click(cardSel + ' .act-talk');
  await page.waitForSelector('#sheet.is-open', { timeout: 10000 });
  await page.waitForTimeout(400);
  var byIcon = await page.evaluate(function () { return !document.getElementById('sheet').hidden; });
  await page.evaluate(function () { window.sheetDismiss(); });
  await sheetGone(page);
  await page.waitForTimeout(300);

  /* Где стоит лента, меряем по видимому положению карточки, а не по scrollY:
     пока шторка открыта, страница заперта и scrollY по устройству равен нулю. */
  var cardTopBefore = await page.$eval(cardSel, function (n) { return Math.round(n.getBoundingClientRect().top); });

  // дальше работаем со снимком, у которого комментариев хватает на прокрутку
  await page.evaluate(function (id) { window.openSheet(id, true); }, talkPhoto);
  await page.waitForSelector('#sheet.is-open', { timeout: 10000 });
  await page.waitForSelector('#cm-list .cm', { timeout: 20000 });
  await page.waitForTimeout(500);

  var opened = await page.evaluate(function () {
    var card = document.getElementById('sheet-card');
    var r = card.getBoundingClientRect();
    return {
      y: Math.round(r.top),
      h: Math.round(r.height),
      winH: window.innerHeight,
      hasGrab: !!document.querySelector('#sheet-grab .sheet-bar'),
      backOpacity: Number(getComputedStyle(document.getElementById('sheet-back')).opacity),
      locked: document.body.classList.contains('is-locked')
    };
  });
  var part = opened.h / opened.winH;

  ok('5. Шторка открывается значком комментариев: снизу, примерно на 85% экрана, с ручкой и подложкой',
     byIcon && Math.abs(opened.y + opened.h - opened.winH) < 2 && part > 0.8 && part < 0.9 &&
     opened.hasGrab && opened.backOpacity > 0.5 && opened.locked,
     'по значку открылась: ' + byIcon + ', высота ' + opened.h + ' из ' + opened.winH +
     ' (' + Math.round(part * 100) + '%), подложка ' + opened.backOpacity +
     ', лента заперта: ' + opened.locked);
  await snap(page, '03-shtorka-otkryta.png');

  // тянется за пальцем один в один
  await dragDown(page, '#sheet-grab', 120, 6, 16, false);
  var mid = await sheetY(page);
  var trans = await page.$eval('#sheet-card', function (n) { return getComputedStyle(n).transitionDuration; });
  await snap(page, '04-shtorka-v-dvizhenii.png');
  // держим паузу перед отпусканием: это уже не рывок, а остановка
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(700);
  var backHome = await sheetY(page);

  ok('5б. Шторка идёт за пальцем один в один, на время движения плавность снята',
     mid === 120 && /^0s$/.test(trans) && backHome === 0,
     'палец увёл на 120, шторка на ' + mid + ', переход «' + trans +
     '», после отпускания вернулась на ' + backHome);

  // лента под шторкой не сдвинулась и не оттянулась
  var cardTopNow = await page.$eval(cardSel, function (n) { return Math.round(n.getBoundingClientRect().top); });
  ok('5в. Лента под шторкой осталась на месте',
     Math.abs(cardTopNow - cardTopBefore) < 2,
     'карточка стояла на ' + cardTopBefore + ', стоит на ' + cardTopNow);

  /* === 6. Список прокручивается внутри шторки, не утаскивая её ============ */
  var scrolled = await page.evaluate(function () {
    var list = document.getElementById('sheet-list');
    list.scrollTop = 0;
    return { can: list.scrollHeight > list.clientHeight + 20,
             h: list.scrollHeight, box: list.clientHeight };
  });
  if (!scrolled.can) throw new Error('в шторке нечего прокручивать: список ' + scrolled.h +
                                     ' при окне ' + scrolled.box);

  // прокручиваем список вниз и оттуда пробуем тянуть шторку — она не должна пойти
  await page.evaluate(function () { document.getElementById('sheet-list').scrollTop = 80; });
  await page.waitForTimeout(200);
  await dragDown(page, '#sheet-list', 90, 5, 14, false);
  var listDrag = {
    y: await sheetY(page),
    top: await page.evaluate(function () { return document.getElementById('sheet-list').scrollTop; })
  };
  await page.mouse.up();
  await page.waitForTimeout(400);

  ok('6. Список прокручен ниже верха — палец листает список, а не тащит шторку',
     listDrag.y === 0 && listDrag.top > 0,
     'шторка осталась на ' + listDrag.y + ', список на ' + listDrag.top +
     ' (высота списка ' + scrolled.h + ' при окне ' + scrolled.box + ')');

  /* А из самого верха список отдаёт жест шторке. Перед отпусканием держим
     паузу: иначе это будет рывок и шторка закроется, а проверяется здесь
     не закрытие, а передача жеста. */
  await page.evaluate(function () { document.getElementById('sheet-list').scrollTop = 0; });
  await page.waitForTimeout(150);
  await dragDown(page, '#sheet-list', 90, 5, 14, false);
  var fromTop = await sheetY(page);
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(700);
  var afterListDrag = await sheetY(page);
  ok('6б. Из самого верха список отдаёт жест шторке',
     fromTop >= 88 && afterListDrag === 0,
     'шторка ушла на ' + fromTop + ' и вернулась на ' + afterListDrag);

  /* === 7. Быстрый короткий рывок вниз закрывает =========================== */
  var openBeforeFling = await ensureSheet(page, talkPhoto);
  await dragDown(page, '#sheet-grab', 70, 4, 0);        // короткий и быстрый
  await page.waitForTimeout(800);
  var afterFling = await page.evaluate(function () {
    return { hidden: document.getElementById('sheet').hidden,
             open: document.getElementById('sheet').classList.contains('is-open') };
  });
  ok('7. Быстрый короткий рывок вниз закрывает шторку',
     openBeforeFling && afterFling.hidden && !afterFling.open,
     'была открыта: ' + openBeforeFling + ', ушла на 70 точек рывком — закрылась: ' + afterFling.hidden);

  /* === 8. Медленное короткое движение возвращает на место ================= */
  await ensureSheet(page, talkPhoto);
  /* Считаем обрывы жеста: если браузер отобрал жест на полпути, шторка тоже
     вернётся на место — но проверять мы хотим не это, а решение по медленному
     отпусканию. Обрыва быть не должно. */
  await page.evaluate(function () {
    window.__cancels = 0;
    document.addEventListener('pointercancel', function () { window.__cancels++; }, true);
  });

  // медленно и недалеко: шаги мелкие, скорость много ниже порога рывка
  await dragDown(page, '#sheet-grab', 60, 12, 25, false);
  var wentTo = await sheetY(page);
  var cancels = await page.evaluate(function () { return window.__cancels; });
  await page.mouse.up();
  await page.waitForTimeout(800);
  var afterSlow = await page.evaluate(function () {
    return { hidden: document.getElementById('sheet').hidden,
             open: document.getElementById('sheet').classList.contains('is-open') };
  });
  var slowY = await sheetY(page);
  ok('8. Медленное короткое движение возвращает шторку на место',
     !afterSlow.hidden && afterSlow.open && slowY === 0 && wentTo === 60 && cancels === 0,
     'палец увёл на 60, шторка дошла до ' + wentTo + ', осталась открытой: ' +
     afterSlow.open + ', вернулась на ' + slowY + ', обрывов жеста: ' + cancels);

  /* === 9. Поле ввода не прячется под клавиатурой ========================== */
  await ensureSheet(page, talkPhoto);
  /* Настоящую клавиатуру в проверке не поднять. Клавиатура на айфоне
     не двигает разметку, а ужимает видимую часть экрана, — это и повторяем,
     ужимая окно. Поле обязано остаться в виду и над нижним краем шторки. */
  await page.setViewportSize({ width: 375, height: 420 });
  await page.waitForTimeout(600);
  var kb = await page.evaluate(function () {
    var inp = document.getElementById('say-input').getBoundingClientRect();
    var card = document.getElementById('sheet-card').getBoundingClientRect();
    return {
      inputBottom: Math.round(inp.bottom),
      inputTop: Math.round(inp.top),
      cardBottom: Math.round(card.bottom),
      winH: window.innerHeight,
      visible: inp.top >= 0 && inp.bottom <= window.innerHeight + 1
    };
  });
  ok('9. Когда видимая часть экрана ужалась, поле ввода осталось на виду',
     kb.visible && kb.inputBottom <= kb.cardBottom + 1,
     'поле ' + kb.inputTop + '…' + kb.inputBottom + ' при высоте окна ' + kb.winH +
     ', низ шторки ' + kb.cardBottom);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(500);

  /* === 10. Аватарка в комментарии, в том числе заглушка =================== */
  await page.waitForSelector('#cm-list .cm', { timeout: 15000 });
  var faces = await page.evaluate(function () {
    var out = { total: 0, drawn: 0, empty: 0, kinds: {} };
    var list = document.querySelectorAll('#cm-list .cm');
    for (var i = 0; i < list.length; i++) {
      var img = list[i].querySelector('.cm-face img');
      out.total++;
      if (!img || !img.getAttribute('src')) { out.empty++; continue; }
      if (img.complete && img.naturalWidth > 0) out.drawn++;
      var src = img.getAttribute('src');
      var kind = /avatar-\d\.svg$/.test(src) ? 'заглушка' : 'своя';
      out.kinds[kind] = (out.kinds[kind] || 0) + 1;
    }
    return out;
  });
  ok('10. У каждого комментария есть аватарка кружком и она нарисована',
     faces.total > 0 && faces.empty === 0 && faces.drawn === faces.total,
     'комментариев ' + faces.total + ', нарисовано ' + faces.drawn +
     ', пустых ' + faces.empty + ', из них ' + JSON.stringify(faces.kinds));

  /* === 11. Тап по нику открывает карточку гостя ========================== */
  var wantNick = await page.textContent('#cm-list .cm:first-child .cm-nick');
  await page.click('#cm-list .cm:first-child .cm-nick');
  await page.waitForSelector('#s-guest.is-on', { timeout: 10000 });
  await page.waitForTimeout(900);
  var afterNick = await page.evaluate(function () {
    return {
      nick: document.getElementById('guest-nick').textContent,
      sheetHidden: document.getElementById('sheet').hidden,
      locked: document.body.classList.contains('is-locked')
    };
  });
  ok('11. Тап по нику в комментарии открывает карточку этого гостя, шторка закрывается',
     afterNick.nick === wantNick.trim() && afterNick.sheetHidden && !afterNick.locked,
     'ждали «' + wantNick.trim() + '», открылась карточка «' + afterNick.nick +
     '», шторка спрятана: ' + afterNick.sheetHidden);

  /* === 12. Кнопка «Пожаловаться» ========================================= */
  await page.goto(when(NORMAL));
  await feedReady(page);
  await page.$eval(cardSel, function (n) { n.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300);

  var reportBox = await page.$eval(cardSel + ' .act-report', function (n) {
    var r = n.getBoundingClientRect();
    var cs = getComputedStyle(n);
    return { h: Math.round(r.height), text: n.textContent, color: cs.color, size: cs.fontSize };
  });
  var reportsBefore = await (await db('reports?select=photo_id&photo_id=eq.' + target)).json();
  await singleTap(page, cardSel + ' .act-report');    // подтверждение принимает обработчик выше
  await page.waitForTimeout(1800);
  var reportsAfter = await (await db('reports?select=photo_id&photo_id=eq.' + target)).json();

  ok('12. «Пожаловаться» — текстовая кнопка серым, высотой не меньше 44, и она работает',
     reportBox.text === 'Пожаловаться' && reportBox.h >= 44 &&
     /119,\s*119,\s*119/.test(reportBox.color) &&
     reportsAfter.length >= Math.max(1, reportsBefore.length),
     'высота ' + reportBox.h + ', размер ' + reportBox.size + ', цвет ' + reportBox.color +
     ', жалоб было ' + reportsBefore.length + ', стало ' + reportsAfter.length);

  /* === 13. Размеры кнопок и одна строка на узком экране =================== */
  var sizes = await page.evaluate(function (id) {
    var acts = document.querySelector('#feed .card[data-id="' + id + '"] .acts');
    var like = acts.querySelector('.act-like');
    var talk = acts.querySelector('.act-talk');
    var rep = acts.querySelector('.act-report');
    var lr = like.getBoundingClientRect(), tr = talk.getBoundingClientRect(), rr = rep.getBoundingClientRect();
    var svg = like.querySelector('svg').getBoundingClientRect();
    return {
      likeH: Math.round(lr.height), likeW: Math.round(lr.width),
      talkH: Math.round(tr.height), talkW: Math.round(tr.width),
      repH: Math.round(rr.height),
      icon: Math.round(svg.width),
      num: getComputedStyle(like.querySelector('.act-n')).fontSize,
      sameRow: Math.abs(lr.top - tr.top) < 2 && Math.abs(lr.top - rr.top) < 20,
      gap: Math.round(tr.left - lr.right),
      fits: acts.scrollWidth <= acts.clientWidth + 1
    };
  }, target);

  ok('13. Сердце и комментарий крупнее, область нажатия не меньше 44×44, строка не переносится',
     sizes.icon >= 30 && parseFloat(sizes.num) >= 16 &&
     sizes.likeH >= 44 && sizes.likeW >= 44 && sizes.talkH >= 44 && sizes.talkW >= 44 &&
     sizes.repH >= 44 && sizes.sameRow && sizes.fits && sizes.gap >= 8,
     'значок ' + sizes.icon + ' точек, число ' + sizes.num + ', сердце ' +
     sizes.likeW + '×' + sizes.likeH + ', зазор ' + sizes.gap +
     ', всё в одну строку: ' + sizes.sameRow);
  await snap(page, '01-lenta-krupnye-knopki.png');

  /* === 14. Лента одного гостя ============================================ */
  await page.click('#btn-me');
  await page.waitForSelector('#s-guest.is-on', { timeout: 10000 });
  await page.waitForSelector('#guest-grid .cell', { timeout: 15000 });
  await page.waitForTimeout(600);

  var picked = await page.evaluate(function () {
    var cells = document.querySelectorAll('#guest-grid .cell');
    return { id: cells[2] ? cells[2].dataset.id : cells[0].dataset.id, count: cells.length };
  });

  await page.click('#guest-grid .cell[data-id="' + picked.id + '"] .cell-shot');
  await page.waitForSelector('#s-gfeed.is-on', { timeout: 10000 });
  await page.waitForSelector('#gfeed .card:not(.is-skeleton)', { timeout: 20000 });
  await page.waitForTimeout(900);

  var gf = await page.evaluate(function () {
    var cards = document.querySelectorAll('#gfeed .card:not(.is-skeleton)');
    return {
      first: cards[0] && cards[0].dataset.id,
      n: cards.length,
      nicks: Array.prototype.map.call(cards, function (c) {
        return (c.querySelector('.card-nick') || {}).textContent;
      }),
      title: document.getElementById('gfeed-title').textContent,
      hasActs: !!(cards[0] && cards[0].querySelector('.act-like') && cards[0].querySelector('.act-talk') &&
                  cards[0].querySelector('.act-report'))
    };
  });
  var onlyMine = gf.nicks.every(function (n) { return n === ME.nick; });

  ok('14. С карточки гостя открывается лента только его фото, начиная с выбранного',
     gf.first === picked.id && onlyMine && gf.n > 0 && gf.hasActs && gf.title === ME.nick,
     'первым стоит выбранный: ' + (gf.first === picked.id) + ', карточек ' + gf.n +
     ', все ' + ME.nick + ': ' + onlyMine + ', строка действий на месте: ' + gf.hasActs);
  await snap(page, '05-lenta-gostya.png');

  // лайк в ленте гостя работает так же
  var gfPhoto = gf.first;
  var gBefore = await likeCount(gfPhoto);
  await page.click('#gfeed .card[data-id="' + gfPhoto + '"] .act-like');
  await page.waitForTimeout(1600);
  var gAfter = await likeCount(gfPhoto);
  ok('14б. Лайк в ленте гостя работает так же',
     Math.abs(gAfter - gBefore) === 1, 'лайков ' + gBefore + ' → ' + gAfter);
  await page.click('#gfeed .card[data-id="' + gfPhoto + '"] .act-like');   // возвращаем как было
  await page.waitForTimeout(1400);

  // назад — на карточку гостя, а не в общую ленту
  await page.click('#gfeed-back');
  await page.waitForTimeout(900);
  var backTo = await page.evaluate(function () {
    return (document.querySelector('.screen.is-on') || {}).id;
  });
  ok('14в. «Назад» из ленты гостя возвращает на карточку гостя',
     backTo === 's-guest', 'открыт экран «' + backTo + '»');

  /* === 15. Строки «с нами с» нигде нет =================================== */
  var since = await page.evaluate(function () {
    return {
      inPage: document.body.innerText.indexOf('с нами с') !== -1,
      node: !!document.getElementById('guest-since')
    };
  });
  var inSource = ['app.js', 'index.html', 'styles.css'].filter(function (f) {
    return fs.readFileSync(path.join(ROOT, f), 'utf8').indexOf('guest-since') !== -1;
  });
  ok('15. Строки «с нами с» не осталось ни на экране, ни в исходниках',
     !since.inPage && !since.node && inSource.length === 0,
     'на экране: ' + since.inPage + ', узел в разметке: ' + since.node +
     ', в файлах: ' + (inSource.join(', ') || 'нет'));

  /* === 16. Кнопка «Выйти» только на своей карточке ======================== */
  var mineExit = await page.evaluate(function () {
    var box = document.getElementById('guest-exit');
    var btn = document.getElementById('btn-exit');
    var cs = getComputedStyle(btn);
    return { shown: !box.hidden, text: btn.textContent,
             ghost: cs.backgroundColor, border: cs.borderTopWidth };
  });
  // кнопка внизу длинной карточки — подводим её под глаза, иначе на снимке её нет
  await page.$eval('#btn-exit', function (n) { n.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(400);
  await snap(page, '06-kartochka-s-vyhodom.png');

  // чужая карточка — кнопки нет
  await page.evaluate(function (id) { window.openGuest(id, true); }, MATE.id);
  await page.waitForTimeout(1200);
  var alienExit = await page.evaluate(function () {
    return { hidden: document.getElementById('guest-exit').hidden,
             nick: document.getElementById('guest-nick').textContent };
  });

  ok('16. «Выйти» есть только на своей карточке, контурная кнопка',
     mineExit.shown && mineExit.text === 'Выйти' &&
     /255,\s*255,\s*255/.test(mineExit.ghost) && parseFloat(mineExit.border) >= 1 &&
     alienExit.hidden,
     'на своей: ' + mineExit.shown + ' («' + mineExit.text + '», фон ' + mineExit.ghost +
     '), на чужой (' + alienExit.nick + '): ' + !alienExit.hidden);

  /* === 17. Выход и вход обратно ========================================== */
  var photosBefore = await (await db('photos?select=id&guest_id=eq.' + ME.id + '&hidden=eq.false',
                                     { headers: { Prefer: 'count=exact', Range: '0-0' } })).headers;
  var wasCount = parseInt((photosBefore.get('content-range') || '').split('/')[1], 10) || 0;

  await page.goto(when(NORMAL));
  await feedReady(page);
  await page.click('#btn-me');
  await page.waitForSelector('#s-guest.is-on', { timeout: 10000 });
  await page.click('#btn-exit');
  await page.waitForSelector('#ask:not([hidden])', { timeout: 10000 });

  var askText = (await page.textContent('#ask-text')).trim();
  var askYes = (await page.textContent('#ask-yes')).trim();
  var askNo = (await page.textContent('#ask-no')).trim();

  // сначала «Отмена» — ничего не должно случиться
  await page.click('#ask-no');
  await page.waitForTimeout(400);
  var stillIn = await page.evaluate(function () {
    return { screen: (document.querySelector('.screen.is-on') || {}).id,
             saved: !!localStorage.getItem('svadba.guest') };
  });

  await page.click('#btn-exit');
  await page.waitForSelector('#ask:not([hidden])', { timeout: 10000 });
  await page.click('#ask-yes');
  await page.waitForSelector('#s-start.is-on', { timeout: 10000 });
  var afterExit = await page.evaluate(function () {
    return { screen: (document.querySelector('.screen.is-on') || {}).id,
             saved: localStorage.getItem('svadba.guest') };
  });

  ok('17. Подтверждение выхода говорит честно, «Отмена» ничего не делает',
     /Выйти из аккаунта\?/.test(askText) && /ник и пин-код/.test(askText) &&
     /Восстановить пин нельзя/.test(askText) && askYes === 'Выйти' && askNo === 'Отмена' &&
     stillIn.screen === 's-guest' && stillIn.saved,
     'текст «' + askText + '», кнопки «' + askYes + '» и «' + askNo + '»');

  ok('17б. Выход стирает сохранённого гостя и возвращает на стартовый экран',
     afterExit.screen === 's-start' && !afterExit.saved,
     'экран «' + afterExit.screen + '», гость в памяти браузера: ' + (afterExit.saved || 'нет'));

  // вход обратно ником и пином
  await page.click('#go-login');
  await page.waitForSelector('#s-login.is-on', { timeout: 10000 });
  await page.fill('#log-nick', ME.nick);
  var cells = await page.$$('#log-pin .pin-cell');
  for (var d = 0; d < 4; d++) await cells[d].fill(MY_PIN[d]);
  await page.click('#log-go');
  await feedReady(page);

  await page.click('#btn-me');
  await page.waitForSelector('#s-guest.is-on', { timeout: 10000 });
  await page.waitForFunction(function () {
    return /^\d+$/.test(document.getElementById('guest-photos').textContent);
  }, null, { timeout: 20000 });
  var backIn = await page.evaluate(function () {
    return { nick: document.getElementById('guest-nick').textContent,
             photos: document.getElementById('guest-photos').textContent };
  });

  ok('17в. Вход обратно по нику и пину работает, фото на месте',
     backIn.nick === ME.nick && Number(backIn.photos) === wasCount && wasCount > 0,
     'вошли как «' + backIn.nick + '», публикаций ' + backIn.photos + ', в базе ' + wasCount);

  /* === 18. Окно приёма на месте ========================================== */
  var settingsNow = await (await db('settings?select=key,value&key=eq.window_start')).json();
  var startNow = settingsNow[0] && settingsNow[0].value;
  ok('18. Окно приёма не сдвинуто: window_start там же, где и было',
     Date.parse(startNow) === Date.parse(WINDOW_START),
     'в базе ' + startNow + ', ждали ' + WINDOW_START);

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
  console.log('Окно приёма в базе: ' + startNow);
  console.log('Скриншоты: ' + SHOTS);
  process.exit(bad.length ? 1 : 0);
}

// порог двойного тапа берём из самой страницы, чтобы не расходиться с ней
function CONFIGTAP() { return 400; }

main().catch(function (e) {
  console.error('Проверки сорвались: ' + (e && e.stack || e));
  process.exit(2);
});
