/* ============================================================================
   Проверки этапа 3 (лента) через Playwright.
   Запуск:  set NODE_PATH=<папка с playwright>\node_modules && node tests/check-etap3.cjs
   Скриншоты складываются в tests/shots3.

   Временные состояния проверяются параметром ?now=<время> — он действует
   только с локального адреса, на боевом домене его нет.
   ============================================================================ */

var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');
var { startServer } = require('./serve.cjs');
var { loadGuest } = require('./guest.cjs');

var ROOT = path.resolve(__dirname, '..');
var SHOTS = path.join(__dirname, 'shots3');
var PORT = 8124;
var LIVE = process.env.SVADBA_BASE || '';
var BASE = LIVE || ('http://127.0.0.1:' + PORT + '/');

var SUPA = 'https://hwnmqcvvdlfqscoufyki.supabase.co';
var KEY = 'sb_publishable_UQtVcMc-DoTEFFvDKE0mxQ_PV5nCSnn';

// гость, под которым смотрим ленту; данные лежат в tests/guest.local.json
var ME = loadGuest();

var results = [];

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

// Размеры снимка зашиты в имя файла — так же их читает и сама лента
function sizeOf(p) {
  var m = /-(\d{2,5})x(\d{2,5})\.[a-z0-9]+$/i.exec(p || '');
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
}

// Экраны переключаются классом is-on, а не удалением из разметки
function onScreen(page, id) {
  return page.evaluate(function (i) {
    var n = document.getElementById(i);
    return !!(n && n.classList.contains('is-on'));
  }, id);
}

function seed(page) {
  return page.addInitScript(function (g) {
    try { localStorage.setItem('svadba.guest', JSON.stringify(g)); } catch (e) {}
  }, ME);
}

/* Снимок экрана делаем только когда картинки рядом с окном уже пришли —
   иначе в отчёт попадают серые прямоугольники вместо фотографий. */
async function snap(page, name) {
  await page.waitForFunction(function () {
    return Array.prototype.slice.call(document.images).every(function (i) {
      var r = i.getBoundingClientRect();
      var near = r.width > 0 && r.bottom > -200 && r.top < window.innerHeight + 200;
      return !near || i.complete;
    });
  }, null, { timeout: 20000 }).catch(function () { /* не дождались — снимем как есть */ });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

function feedReady(page) {
  return page.waitForFunction(function () {
    var c = document.getElementById('feed-count');
    return c && /Всего фото: \d+/.test(c.textContent) &&
           document.querySelectorAll('#feed .card:not(.is-skeleton)').length > 0;
  }, null, { timeout: 30000 });
}

/* --------------------------------------------------------------------------
   Основной ход
   -------------------------------------------------------------------------- */

async function main() {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  var server = LIVE ? null : await startServer(ROOT, PORT);
  var browser = await chromium.launch();
  var ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    locale: 'ru-RU'
  });

  // --- что сейчас в базе: цифры для сверки берём оттуда, а не вписываем руками
  var allPhotos = await (await db('photos?select=id,guest_id,preview_path,created_at&hidden=eq.false&order=created_at.desc,id.desc')).json();
  var allGuests = await (await db('guests_public?select=id,nick')).json();
  var allLikes = await (await db('likes?select=photo_id')).json();
  console.log('\nВ базе: фото ' + allPhotos.length + ', гостей ' + allGuests.length + ', лайков ' + allLikes.length + '\n');

  var page = await ctx.newPage();
  page.on('pageerror', function (e) { console.log('  !! ошибка на странице: ' + e.message); });
  await seed(page);

  /* === 1. Лента показывает фото, новые сверху ============================ */
  await page.goto(when('2026-08-06T18:00:00+03:00'));   // обычный режим
  await feedReady(page);

  var shown = await page.$$eval('#feed .card:not(.is-skeleton) .card-shot img', function (imgs) {
    return imgs.map(function (i) { return decodeURIComponent(i.getAttribute('src').split('/photos/')[1]); });
  });
  var expected = allPhotos.slice(0, 12).map(function (p) { return p.preview_path; });
  var sameOrder = shown.length === 12 && shown.every(function (s, i) { return s === expected[i]; });
  ok('1. Лента показывает фото, новые сверху', sameOrder,
     sameOrder ? ('первые 12 совпали с базой') : ('на экране ' + shown.length + ', сверху ' + shown[0]));

  var countText = await page.textContent('#feed-count');
  ok('1б. Счётчик показывает все фото', countText === 'Всего фото: ' + allPhotos.length, countText);

  await snap(page, '01-lenta.png');

  /* === 2. Вертикальное фото не обрезано ================================== */
  // Берём заведомо вертикальный снимок из базы, подматываем к нему и ждём
  // именно его: соседние картинки грузятся лениво и меряться нечем.
  var tallPhoto = allPhotos.slice(0, 12).find(function (p) {
    var s = sizeOf(p.preview_path);
    return s && s.h > s.w * 1.3;
  });
  var tallFile = tallPhoto ? tallPhoto.preview_path.split('/').pop() : '';

  var shot2 = await page.evaluate(async function (file) {
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
  }, tallFile);

  var noCrop = !!shot2 && shot2.nh > shot2.nw &&
               Math.abs(shot2.box - shot2.nat) < 0.02 &&
               shot2.fillH > 0.98 && shot2.fillW > 0.98;
  ok('2. Вертикальное фото не обрезано', noCrop,
     shot2 ? (tallFile + ': снимок ' + shot2.nw + '×' + shot2.nh +
              ', пропорции ' + shot2.nat.toFixed(3) + ' против рамки ' + shot2.box.toFixed(3) +
              ', видно по высоте ' + (shot2.fillH * 100).toFixed(0) + '%')
           : 'вертикальный снимок не найден');

  await page.waitForTimeout(400);
  await snap(page, '03-vertikalnoe-foto.png');

  /* === 3. Прокрутка подгружает следующую порцию ========================== */
  var before = await page.$$eval('#feed .card:not(.is-skeleton)', function (n) { return n.length; });
  await page.evaluate(function () { window.scrollTo(0, document.body.scrollHeight); });
  await page.waitForFunction(function (was) {
    return document.querySelectorAll('#feed .card:not(.is-skeleton)').length > was;
  }, before, { timeout: 20000 });
  var after = await page.$$eval('#feed .card:not(.is-skeleton)', function (n) { return n.length; });
  ok('3. Прокрутка подгружает следующую порцию', before === 12 && after > before,
     'было ' + before + ', стало ' + after);
  await snap(page, '04-podgruzka.png');

  // домотать до конца
  for (var k = 0; k < 4; k++) {
    await page.evaluate(function () { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(700);
  }
  var total = await page.$$eval('#feed .card:not(.is-skeleton)', function (n) { return n.length; });
  ok('3б. Догружается вся лента', total === allPhotos.length, 'на экране ' + total + ' из ' + allPhotos.length);

  /* === 4. Плашка о новых фото ============================================ */
  // вставляем чужой снимок и ждём тридцатисекундной проверки
  // Время у тестовых снимков расставлено вручную и может обгонять настоящие
  // часы, поэтому новую запись кладём строго свежее самой свежей в ленте.
  // Записываем снимок на заведомо тестового гостя: удалять записи публичным
  // ключом нельзя, и каждый прогон оставляет след — пусть он будет заметным.
  var junkIds = allGuests
    .filter(function (g) { return /^(probe|тест)/i.test(g.nick) && g.id !== ME.id; })
    .map(function (g) { return g.id; });
  var donor = allPhotos.find(function (p) { return junkIds.indexOf(p.guest_id) >= 0; }) ||
              allPhotos.find(function (p) { return p.guest_id !== ME.id; });
  var newestMs = Math.max.apply(null, allPhotos.map(function (p) { return Date.parse(p.created_at); }));
  var ins = await db('photos', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      guest_id: donor.guest_id,
      preview_path: donor.preview_path,
      created_at: new Date(Math.max(Date.now(), newestMs) + 60000).toISOString()
    })
  });
  var insRow = (await ins.json())[0];
  console.log('  (вставлена запись для проверки плашки: ' + insRow.id + ')');

  await page.evaluate(function () { window.scrollTo(0, 0); });
  var barShown = true;
  try {
    await page.waitForSelector('#newbar:not([hidden])', { timeout: 40000 });
  } catch (e) { barShown = false; }
  var barText = barShown ? (await page.textContent('#newbar')) : '';
  ok('4. Плашка о новых фото появилась', barShown && /новое фото|новых фото/.test(barText), barText || 'не появилась');
  if (barShown) await snap(page, '05-plashka-novye.png');

  if (barShown) {
    await page.click('#newbar');
    // лента перерисовывается: сперва серые прямоугольники, только потом карточки
    await page.waitForFunction(function () {
      var b = document.getElementById('newbar');
      return b && b.hidden && window.scrollY < 5 &&
             document.querySelectorAll('#feed .card:not(.is-skeleton)').length > 0;
    }, null, { timeout: 20000 });
    var newTop = await page.$eval('#feed .card:not(.is-skeleton) .card-shot img', function (i) { return i.getAttribute('src'); });
    ok('4б. По нажатию лента обновилась и уехала наверх', true, 'сверху ' + newTop.split('/').pop());
  }

  /* === 5. Карточка гостя ================================================= */
  // проверка плашки добавила запись — пересчитываем то, с чем сверяемся
  allPhotos = await (await db('photos?select=id,guest_id,preview_path,created_at&hidden=eq.false&order=created_at.desc,id.desc')).json();
  allLikes = await (await db('likes?select=photo_id')).json();

  function statsFor(gid) {
    var mine = allPhotos.filter(function (p) { return p.guest_id === gid; });
    var ids = mine.map(function (p) { return p.id; });
    var likes = allLikes.filter(function (l) { return ids.indexOf(l.photo_id) >= 0; }).length;
    return { photos: mine.length, likes: likes };
  }

  // чужая карточка — берём автора с самым большим числом снимков
  var others = {};
  allPhotos.forEach(function (p) { if (p.guest_id !== ME.id) others[p.guest_id] = (others[p.guest_id] || 0) + 1; });
  var pickId = Object.keys(others).sort(function (a, b) { return others[b] - others[a]; })[0];
  var pickNick = (allGuests.find(function (g) { return g.id === pickId; }) || {}).nick;
  var want = statsFor(pickId);

  await page.goto(when('2026-08-06T18:00:00+03:00'));
  await feedReady(page);

  /* Открываем штатным путём — нажатием на ник в ленте. Нужного автора может
     не быть в первой порции: сверху стоят самые свежие снимки, и одна пачка
     загрузок легко занимает её целиком. Поэтому домастываем ленту, пока ник
     не покажется или карточки не кончатся. */
  var opened = false;
  for (var pass = 0; pass < 12 && !opened; pass++) {
    var nickButtons = await page.$$('#feed .card-who');
    for (var i = 0; i < nickButtons.length; i++) {
      var txt = (await nickButtons[i].textContent()).trim();
      if (txt === pickNick) { await nickButtons[i].click(); opened = true; break; }
    }
    if (opened) break;
    var had = nickButtons.length;
    await page.evaluate(function () { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForFunction(function (was) {
      return document.querySelectorAll('#feed .card:not(.is-skeleton)').length > was;
    }, had, { timeout: 8000 }).catch(function () {});
    var now = await page.$$eval('#feed .card:not(.is-skeleton)', function (n) { return n.length; });
    if (now === had) break;                       // лента кончилась
  }
  ok('5. Карточка гостя открывается нажатием на ник', opened, pickNick);

  await page.waitForFunction(function () {
    return document.getElementById('guest-photos').textContent !== '—' &&
           document.getElementById('guest-likes').textContent !== '—';
  }, null, { timeout: 20000 });

  var gotPhotos = parseInt(await page.textContent('#guest-photos'), 10);
  var gotLikes = parseInt(await page.textContent('#guest-likes'), 10);
  var gotNick = (await page.textContent('#guest-nick')).trim();
  var cells = await page.$$eval('#guest-grid .cell', function (n) { return n.length; });
  var delBtns = await page.$$eval('#guest-grid .cell-del', function (n) { return n.length; });

  ok('5б. Цифры на чужой карточке верные',
     gotPhotos === want.photos && gotLikes === want.likes && gotNick === pickNick,
     gotNick + ': публикаций ' + gotPhotos + ' (ждали ' + want.photos + '), лайков ' + gotLikes + ' (ждали ' + want.likes + ')');
  ok('5в. Сетка снимков заполнена', cells === want.photos, 'ячеек ' + cells);
  ok('5г. На чужой карточке нельзя удалять', delBtns === 0, 'кнопок удаления ' + delBtns);
  await snap(page, '06-kartochka-chuzhaya.png');

  // назад в ленту
  await page.click('#guest-back');
  await page.waitForTimeout(600);
  ok('5д. Кнопка «назад» возвращает в ленту', await onScreen(page, 's-feed'));

  // своя карточка — через значок в шапке
  var mineWant = statsFor(ME.id);
  await page.click('#btn-me');
  await page.waitForFunction(function () {
    return document.getElementById('guest-photos').textContent !== '—' &&
           document.getElementById('guest-likes').textContent !== '—';
  }, null, { timeout: 20000 });
  var myPhotos = parseInt(await page.textContent('#guest-photos'), 10);
  var myLikes = parseInt(await page.textContent('#guest-likes'), 10);
  var myDel = await page.$$eval('#guest-grid .cell-del', function (n) { return n.length; });
  ok('5е. Цифры на своей карточке верные',
     myPhotos === mineWant.photos && myLikes === mineWant.likes,
     'публикаций ' + myPhotos + ' (ждали ' + mineWant.photos + '), лайков ' + myLikes + ' (ждали ' + mineWant.likes + ')');
  ok('5ж. На своей карточке под каждым фото есть удаление', myDel === mineWant.photos, 'кнопок ' + myDel);
  await snap(page, '07-kartochka-svoya.png');

  /* === 6. Четыре временных состояния ===================================== */
  // до 6 августа 12:00
  await page.goto(when('2026-08-05T10:00:00+03:00'));
  await feedReady(page);
  var plusOff = await page.$eval('#btn-plus', function (b) { return b.classList.contains('is-off'); });
  var ribbon1 = await page.isVisible('#ribbon-readonly');
  await page.click('#btn-plus');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  var toast1 = (await page.textContent('#toast')).trim();
  ok('6a. До 6 августа: лента работает, плюс серый, сообщение о сроке',
     plusOff && !ribbon1 && toast1 === 'Откроется 6 августа в 12:00', toast1);
  await snap(page, '09-do-6-avgusta.png');

  // обычный режим
  await page.goto(when('2026-08-06T18:00:00+03:00'));
  await feedReady(page);
  var plusOn = await page.$eval('#btn-plus', function (b) { return !b.classList.contains('is-off'); });
  var ribbon2 = await page.isVisible('#ribbon-readonly');
  ok('6б. С 6 по 7 августа: обычный режим, всё доступно', plusOn && !ribbon2,
     'плюс активен: ' + plusOn + ', плашки нет: ' + !ribbon2);
  await snap(page, '10-obychnyj-rezhim.png');

  // только просмотр
  await page.goto(when('2026-08-07T18:00:00+03:00'));
  await feedReady(page);
  var plusOff3 = await page.$eval('#btn-plus', function (b) { return b.classList.contains('is-off'); });
  var ribbon3 = await page.isVisible('#ribbon-readonly');
  var ribbonText = (await page.textContent('#ribbon-readonly')).trim();
  await page.click('#btn-plus');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  ok('6в. С 7 по 8 августа: загрузка закрыта, лента только для просмотра',
     plusOff3 && ribbon3 && ribbonText === 'Загрузка закрыта. Ленту можно смотреть до 8 августа', ribbonText);
  await snap(page, '11-tolko-prosmotr.png');

  // сайт закрыт
  await page.goto(when('2026-08-08T01:00:00+03:00'));
  await page.waitForTimeout(1500);
  var closedOn = await onScreen(page, 's-closed');
  var feedOn = await onScreen(page, 's-feed');
  var startOn = await onScreen(page, 's-start');
  var thanks = (await page.textContent('.thanks-word')).trim();
  ok('6г. После 8 августа: вместо всего сайта страница благодарности',
     closedOn && !feedOn && !startOn && thanks === 'Спасибо, все фото у молодожёнов', thanks);
  await snap(page, '12-sajt-zakryt.png');

  // сайт закрыт и для незарегистрированного гостя
  var clean = await ctx.newPage();
  await clean.goto(when('2026-08-08T01:00:00+03:00'));
  await clean.waitForTimeout(1500);
  var closedClean = await onScreen(clean, 's-closed');
  var startClean = await onScreen(clean, 's-start');
  ok('6д. Закрытый сайт не пускает и новичка', closedClean && !startClean,
     'страница благодарности: ' + closedClean + ', старт: ' + startClean);
  await clean.close();

  /* === 7. Пустая лента =================================================== */
  var empty = await ctx.newPage();
  await seed(empty);
  await empty.route('**/rest/v1/photos*', function (route) {
    var cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'access-control-expose-headers': 'content-range',
      'content-range': '*/0',
      'content-type': 'application/json'
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    route.fulfill({ status: 200, headers: cors, body: '[]' });
  });
  await empty.goto(when('2026-08-06T18:00:00+03:00'));
  await empty.waitForSelector('#feed-empty:not([hidden])', { timeout: 20000 });
  var eTitle = (await empty.textContent('.empty-title')).trim();
  var eSub = (await empty.textContent('.empty-sub')).trim();
  var eCount = (await empty.textContent('#feed-count')).trim();
  ok('7. Пустая лента: значок, «Будьте первым» и подсказка',
     eTitle === 'Будьте первым' && eSub === 'Нажмите плюс и загрузите фото',
     eTitle + ' / ' + eSub + ' / ' + eCount);
  await snap(empty, '08-pustaya-lenta.png');
  await empty.close();

  /* === 8. Шапка не уезжает при прокрутке ================================= */
  await page.goto(when('2026-08-06T18:00:00+03:00'));
  await feedReady(page);
  var topBefore = await page.$eval('.topbar', function (n) { return n.getBoundingClientRect().top; });
  await page.evaluate(function () { window.scrollTo(0, 1200); });
  await page.waitForTimeout(400);
  var topAfter = await page.$eval('#s-feed .topbar', function (n) { return n.getBoundingClientRect().top; });
  ok('8. Шапка закреплена сверху и не уезжает', Math.abs(topAfter - topBefore) < 2,
     'до прокрутки ' + topBefore.toFixed(0) + ', после ' + topAfter.toFixed(0));
  await snap(page, '02-shapka-pri-prokrutke.png');

  /* --- итог --- */
  await browser.close();
  if (server) server.close();

  var bad = results.filter(function (r) { return !r.pass; });
  console.log('\n=================================');
  console.log('Пройдено ' + (results.length - bad.length) + ' из ' + results.length);
  if (bad.length) {
    console.log('Не прошли:');
    bad.forEach(function (b) { console.log('  - ' + b.name + (b.detail ? ' — ' + b.detail : '')); });
  }
  console.log('Скриншоты: ' + SHOTS);
  process.exit(bad.length ? 1 : 0);
}

main().catch(function (e) {
  console.error('Проверки сорвались: ' + (e && e.stack || e));
  process.exit(2);
});
