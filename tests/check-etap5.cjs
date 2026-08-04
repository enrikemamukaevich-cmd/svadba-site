/* ============================================================================
   Проверки этапа 5 (лайки, комментарии, фильтр грубости, жалобы) через
   Playwright. Запуск:  npm run test:5
   Скриншоты складываются в tests/shots5.

   Часы подменяются доводом ?now= — ровно так же, как на этапах 3 и 4.
   Настройку window_start прогон НЕ трогает: сдвигать боевое окно приёма ради
   проверок незачем, а забыть вернуть его на место — легко. В конце прогона
   значение всё равно сверяется с жёсткой константой памятки.

   Прогон оставляет в базе две записи в photos (по ним проверяются жалобы:
   одна набирает две жалобы и остаётся видимой, вторая набирает три и
   прячется) и несколько комментариев. Файлы в хранилище не создаются —
   записи ссылаются на уже лежащее там превью. Чистится всё одним заходом
   перед свадьбой.
   ============================================================================ */

var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright');
var { startServer } = require('./serve.cjs');
var { loadMates } = require('./guest.cjs');

var ROOT = path.resolve(__dirname, '..');
var SHOTS = path.join(__dirname, 'shots5');
var PORT = 8126;
var BASE = 'http://127.0.0.1:' + PORT + '/';

var SUPA = 'https://hwnmqcvvdlfqscoufyki.supabase.co';
var KEY = 'sb_publishable_UQtVcMc-DoTEFFvDKE0mxQ_PV5nCSnn';

// Жёсткая константа памятки. С ней сверяется окно приёма в конце прогона.
var WINDOW_START = '2026-08-06T12:00:00+03:00';

var CREW = loadMates();
var ME = CREW.me, MATE = CREW.mate, MATE2 = CREW.mate2, BANNED = CREW.banned;

var results = [];
var NORMAL = '';
var BOUNDS = {};

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

function rpcAs(name, params) {
  return db('rpc/' + name, { method: 'POST', body: JSON.stringify(params) })
    .then(function (r) { return r.json(); });
}

function when(iso) { return BASE + '?now=' + encodeURIComponent(iso); }

async function loadTimes() {
  var rows = await (await db('settings?select=key,value')).json();
  (rows || []).forEach(function (r) { BOUNDS[r.key] = r.value; });
  var t = Date.parse(BOUNDS.window_start);
  if (isNaN(t)) throw new Error('в настройках нечитаемое время: ' + BOUNDS.window_start);
  NORMAL = new Date(t + 3600000).toISOString();
  console.log('Окно приёма из базы: ' + BOUNDS.window_start + ' — ' + BOUNDS.window_end);
  console.log('Проверяем в момент ' + NORMAL + '\n');
}

/* --------------------------------------------------------------------------
   Работа со страницей
   -------------------------------------------------------------------------- */

function seed(page, guest) {
  return page.addInitScript(function (g) {
    try { localStorage.setItem('svadba.guest', JSON.stringify(g)); } catch (e) {}
  }, guest);
}

function feedReady(page) {
  return page.waitForFunction(function () {
    var c = document.getElementById('feed-count');
    return c && /Всего фото: \d+/.test(c.textContent);
  }, null, { timeout: 30000 }).then(function () {
    // счётчик приходит своим запросом и опережает карточки: без этого
    // ожидания «карточки нет в ленте» означает лишь «она ещё не пришла»
    return page.waitForSelector('#feed .card:not(.is-skeleton)', { timeout: 30000 });
  });
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

// «Согласен» на любое окно подтверждения
function sayYes(page) {
  page.on('dialog', function (d) { d.accept(); });
}
function sayNo(page) {
  page.on('dialog', function (d) { d.dismiss(); });
}

async function newGuestPage(ctx, guest, notes) {
  var page = await ctx.newPage();
  page.on('pageerror', function (e) { console.log('  !! ошибка на странице: ' + e.message); });
  if (notes) notes(page);
  await seed(page, guest);
  await page.goto(when(NORMAL));
  await feedReady(page);
  return page;
}

/* Комментарии открываются шторкой поверх ленты, отдельного экрана у них нет.
   Зовём тем же способом, каким это делает значок комментариев. */
function openPhotoOn(page, row) {
  return page.evaluate(function (id) {
    window.openSheet(id, true);
  }, row.id).then(function () {
    return page.waitForSelector('#sheet.is-open', { timeout: 10000 });
  }).then(function () {
    return page.waitForTimeout(400);           // доводка шторки
  });
}

function closeSheetOn(page) {
  return page.evaluate(function () { window.sheetDismiss(); })
    .then(function () {
      // шторка прячется атрибутом hidden, а не исчезновением из разметки
      return page.waitForFunction(function () {
        return document.getElementById('sheet').hidden;
      }, null, { timeout: 10000 });
    });
}

async function sendComment(page, text) {
  await page.fill('#say-input', '');
  await page.evaluate(function (t) {
    var i = document.getElementById('say-input');
    i.value = t;                       // мимо maxlength: проверяем и длинные
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.click('#say-go');
  await page.waitForTimeout(700);
  return (await page.textContent('#err-say')).trim();
}

/* --------------------------------------------------------------------------
   Данные для проверки жалоб
   -------------------------------------------------------------------------- */

// Две свежие записи под жалобы: у них ноль жалоб, и прошлые прогоны их не трогали
async function makeReportTargets() {
  var mine = await (await db('photos?select=id,preview_path&guest_id=eq.' + ME.id +
                             '&preview_path=like.feed/*&hidden=eq.false&limit=1')).json();
  if (!mine.length) throw new Error('у тестового гостя нет ни одного снимка в feed/');
  var preview = mine[0].preview_path;

  var made = [];
  for (var i = 0; i < 2; i++) {
    var r = await db('photos', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ guest_id: ME.id, preview_path: preview })
    });
    var rows = await r.json();
    if (!rows || !rows[0]) throw new Error('не удалось завести запись для жалоб');
    made.push(rows[0]);
  }
  return made;
}

/* Скрытый снимок публичным ключом не читается вовсе: правила доступа
   отдают только hidden = false. Поэтому пока фото видно, состояние берём
   обычным запросом, а после скрытия — ответом самой программы жалоб.
   Она же и доказывает, что запись цела: у стёртой строки не бывает
   ни числа жалоб, ни признака скрытия. */
function photoState(id) {
  return db('photos?select=id,reports,hidden&id=eq.' + id)
    .then(function (r) { return r.json(); })
    .then(function (rows) { return rows[0] || null; });
}

// Повторная жалоба того, кто уже жаловался: ничего не меняет, но всё рассказывает
function reportProbe(secret, id) {
  return rpcAs('add_report', { p_secret: secret, p_photo_id: id });
}

function likeRows(photoId, guestId) {
  return db('likes?select=photo_id&photo_id=eq.' + photoId + '&guest_id=eq.' + guestId)
    .then(function (r) { return r.json(); });
}

function likeCount(photoId) {
  return db('likes?select=photo_id&photo_id=eq.' + photoId, { headers: { Prefer: 'count=exact', Range: '0-0' } })
    .then(function (r) {
      var n = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
      return isNaN(n) ? 0 : n;
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
    locale: 'ru-RU'
  });

  await loadTimes();

  var targets = await makeReportTargets();
  var PHOTO_A = targets[0];        // наберёт две жалобы и останется видимым
  var PHOTO_B = targets[1];        // наберёт три и спрячется
  console.log('Записи под жалобы: A ' + PHOTO_A.id + ', B ' + PHOTO_B.id + '\n');

  /* Ключи в запросах: слушаем всё, что уходит со страницы гостя.
     Собираем сюда только нарушения, чтобы потом было что показать. */
  var leaks = [];
  function watchLeaks(page, secret, who) {
    page.on('request', function (req) {
      var url = req.url();
      var body = '';
      try { body = req.postData() || ''; } catch (e) { /* тело не всегда доступно */ }
      var inUrl = url.indexOf(secret) !== -1;
      var inBody = body.indexOf(secret) !== -1;
      if (inUrl) leaks.push(who + ': ключ в адресе — ' + url.slice(0, 120));
      if (inBody && !/\/rest\/v1\/rpc\//.test(url)) {
        leaks.push(who + ': ключ в теле запроса не к программе базы — ' + url.slice(0, 120));
      }
    });
  }

  var page = await newGuestPage(ctx, ME, function (p) {
    sayYes(p);
    watchLeaks(p, ME.secret, 'основной гость');
  });

  /* === 1. Лайк ставится и снимается ====================================== */
  var cardSel = '#feed .card[data-id="' + PHOTO_A.id + '"]';
  await page.waitForSelector(cardSel, { timeout: 15000 });

  var shownBefore = await page.textContent(cardSel + ' .act-like .act-n');
  var dbBefore = await likeCount(PHOTO_A.id);

  await page.click(cardSel + ' .act-like');
  var shownAtOnce = await page.textContent(cardSel + ' .act-like .act-n');   // без ожидания сети
  await page.waitForTimeout(1500);
  var shownAfter = await page.textContent(cardSel + ' .act-like .act-n');
  var onAfter = await page.$eval(cardSel + ' .act-like', function (b) { return b.classList.contains('is-on'); });
  var dbAfter = await likeCount(PHOTO_A.id);

  ok('1. Лайк ставится: число выросло сразу и совпало с базой',
     Number(shownAtOnce) === Number(shownBefore) + 1 &&
     Number(shownAfter) === dbAfter && dbAfter === dbBefore + 1 && onAfter,
     'было ' + shownBefore + ', сразу ' + shownAtOnce + ', стало ' + shownAfter +
     ', в базе ' + dbAfter + ', сердце закрашено: ' + onAfter);
  await snap(page, '01-lenta-s-lajkami.png');

  await page.click(cardSel + ' .act-like');
  await page.waitForTimeout(1500);
  var shownOff = await page.textContent(cardSel + ' .act-like .act-n');
  var onOff = await page.$eval(cardSel + ' .act-like', function (b) { return b.classList.contains('is-on'); });
  var dbOff = await likeCount(PHOTO_A.id);
  ok('1б. Повторное нажатие снимает лайк, число вернулось и совпало с базой',
     Number(shownOff) === dbOff && dbOff === dbBefore && !onOff,
     'на экране ' + shownOff + ', в базе ' + dbOff + ', сердце закрашено: ' + onOff);

  /* === 2. Один гость — один лайк ========================================= */
  // ставим обратно и дёргаем ещё дважды: счётчик обязан вернуться к тому же
  await page.click(cardSel + ' .act-like');
  await page.waitForTimeout(1200);
  var twice = await page.evaluate(function (id) {
    return rpc('toggle_like', { p_secret: JSON.parse(localStorage.getItem('svadba.guest')).secret, p_photo_id: id })
      .then(function () {
        return rpc('toggle_like', { p_secret: JSON.parse(localStorage.getItem('svadba.guest')).secret, p_photo_id: id });
      });
  }, PHOTO_A.id);

  var rows = await likeRows(PHOTO_A.id, ME.id);
  var dbTwice = await likeCount(PHOTO_A.id);

  // и в обход программы — прямой записью в таблицу — тоже не удвоить
  var direct = await db('likes', {
    method: 'POST',
    body: JSON.stringify({ photo_id: PHOTO_A.id, guest_id: ME.id })
  });
  var dbAfterDirect = await likeCount(PHOTO_A.id);

  ok('2. Повторный лайк того же гостя не удваивает счётчик',
     rows.length === 1 && dbTwice === dbBefore + 1 && twice && twice.likes === dbTwice &&
     direct.status === 401 && dbAfterDirect === dbTwice,
     'записей лайка у гостя ' + rows.length + ', в базе ' + dbTwice +
     ', прямая запись в таблицу отбита кодом ' + direct.status);

  /* === 3. Комментарий: отправился, показался, удалился автором =========== */
  await openPhotoOn(page, PHOTO_A);

  var errGood = await sendComment(page, 'Какие вы красивые, поздравляем!');
  await page.waitForTimeout(500);
  var listText = await page.textContent('#cm-list');
  var cmInDb = await (await db('comments?select=id,body,guest_id&photo_id=eq.' + PHOTO_A.id)).json();
  var nickBold = await page.$eval('#cm-list .cm:last-child .cm-nick', function (n) {
    return { text: n.textContent, weight: getComputedStyle(n).fontWeight };
  });

  ok('3. Комментарий отправляется и появляется в списке, ник автора полужирным',
     !errGood && /Какие вы красивые/.test(listText) && cmInDb.length === 1 &&
     nickBold.text === ME.nick && Number(nickBold.weight) >= 600,
     'в базе записей: ' + cmInDb.length + ', подпись «' + nickBold.text +
     '» насыщенностью ' + nickBold.weight);

  // и число под фото в ленте выросло
  var talkN = await page.textContent(cardSel + ' .act-talk .act-n');
  ok('3б. Число комментариев под снимком совпадает с базой',
     Number(talkN) === cmInDb.length, 'на экране ' + talkN + ', в базе ' + cmInDb.length);
  await snap(page, '02-stranica-foto.png');

  /* === 4. Чужой комментарий удалить нельзя =============================== */
  var mine1 = cmInDb[0];
  var matePage = await newGuestPage(ctx, MATE, function (p) { sayYes(p); });
  await openPhotoOn(matePage, PHOTO_A);
  await matePage.waitForSelector('#cm-list .cm', { timeout: 15000 });

  var delShownToMate = await matePage.$$eval('#cm-list .cm-del', function (n) { return n.length; });
  var mateTry = await rpcAs('delete_comment', { p_secret: MATE.secret, p_comment_id: mine1.id });
  var stillThere = await (await db('comments?select=id&id=eq.' + mine1.id)).json();

  ok('4. Чужой комментарий удалить нельзя: кнопки нет, а база отказывает',
     delShownToMate === 0 && mateTry && mateTry.ok === false &&
     mateTry.error === 'not_yours' && stillThere.length === 1,
     'кнопок «Удалить» у чужого: ' + delShownToMate + ', база ответила ' + JSON.stringify(mateTry));

  // свой — удаляется
  var delOk = await page.$$eval('#cm-list .cm-del', function (n) { return n.length; });
  await page.click('#cm-list .cm:last-child .cm-del');
  await page.waitForTimeout(1500);
  var gone = await (await db('comments?select=id&id=eq.' + mine1.id)).json();
  var listAfter = await page.textContent('#cm-list');
  ok('3в. Свой комментарий удаляется автором',
     delOk === 1 && gone.length === 0 && !/Какие вы красивые/.test(listAfter),
     'кнопка у себя есть: ' + (delOk === 1) + ', записей в базе осталось ' + gone.length);

  /* === 5. Длиннее 200 знаков не проходит ================================= */
  var long = 'а';
  while (long.length < 201) long += 'б';
  var wasCount = (await (await db('comments?select=id&photo_id=eq.' + PHOTO_A.id)).json()).length;
  var errLong = await sendComment(page, long);
  var nowCount = (await (await db('comments?select=id&photo_id=eq.' + PHOTO_A.id)).json()).length;
  // и в обход страницы база тоже не примет
  var longDb = await rpcAs('add_comment', { p_secret: ME.secret, p_photo_id: PHOTO_A.id, p_body: long });

  ok('5. Комментарий длиннее 200 знаков не проходит ни со страницы, ни мимо неё',
     /Слишком длинно/.test(errLong) && nowCount === wasCount &&
     longDb && longDb.ok === false && longDb.error === 'too_long',
     '201 знак: страница — «' + errLong + '», база — ' + JSON.stringify(longDb));

  // ровно 200 — проходит
  var exact = long.slice(0, 200);
  var errExact = await sendComment(page, exact);
  await page.waitForTimeout(600);
  var after200 = (await (await db('comments?select=id,body&photo_id=eq.' + PHOTO_A.id)).json());
  var got200 = after200.filter(function (c) { return c.body.length === 200; });
  ok('5б. Ровно 200 знаков проходит', !errExact && got200.length === 1,
     'ошибка «' + errExact + '», записей на 200 знаков: ' + got200.length);
  if (got200.length) await rpcAs('delete_comment', { p_secret: ME.secret, p_comment_id: got200[0].id });

  /* === 6. Мат не проходит — десяток искажённых написаний ================= */
  var RUDE = [
    'хуй', 'ХУЙ', 'х.у.й', 'х*у*й', 'х у й', 'хуууй', 'xyй', 'х-у-й',
    'бл*ть', 'бл я ть', '6лядь', 'сууука', 'п и з д а', 'иди на хуй',
    'заебал', 'мудак', 'пидор', 'сцуко'
  ];
  var missed = [];
  for (var i = 0; i < RUDE.length; i++) {
    var e = await sendComment(page, RUDE[i]);
    if (!/Давайте без грубостей/.test(e)) missed.push(RUDE[i] + ' → «' + e + '»');
  }
  var rudeInDb = (await (await db('comments?select=id,body&photo_id=eq.' + PHOTO_A.id)).json());
  ok('6. Грубость не проходит во всех ' + RUDE.length + ' написаниях',
     missed.length === 0 && rudeInDb.length === 0,
     missed.length ? 'просочилось: ' + missed.join('; ')
                   : 'проверено ' + RUDE.length + ' написаний, в базе ' + rudeInDb.length + ' записей');

  // снимок отказа: перечитываем список (200-значный уже убран из базы),
  // пробуем грубость ещё раз и подводим отказ под глаза
  await page.evaluate(function (id) { window.loadComments(id); }, PHOTO_A.id);
  await page.waitForTimeout(900);
  await sendComment(page, 'ты бл*ть');
  await page.evaluate(function () {
    document.getElementById('err-say').scrollIntoView({ block: 'center' });
  });
  await snap(page, '03-otkaz-filtra.png');

  /* === 7. Безобидные слова проходят ===================================== */
  var FINE = [
    'страховка', 'пассажир', 'объективный', 'блокнот', 'сучок',
    'Невеста великолепна, а торт — отдельная песня',
    'колебаться', 'оскорблять', 'требовать', 'барсука', 'победа', 'посуда'
  ];
  var blocked = [];
  var planted = [];
  for (var j = 0; j < FINE.length; j++) {
    var e2 = await sendComment(page, FINE[j]);
    if (e2) blocked.push(FINE[j] + ' → «' + e2 + '»');
  }
  await page.waitForTimeout(600);
  planted = (await (await db('comments?select=id,body&photo_id=eq.' + PHOTO_A.id)).json());
  ok('7. Безобидные слова проходят и доходят до базы',
     blocked.length === 0 && planted.length === FINE.length,
     blocked.length ? 'зря отбито: ' + blocked.join('; ')
                    : 'прошло ' + planted.length + ' из ' + FINE.length);

  /* === 8. Ссылка не проходит ============================================ */
  var LINKS = ['http://spam.ru', 'www.example.com', 'заходите на super-shop.ru', 't.me/kanal', 'магазин.рф'];
  var slipped = [];
  for (var k = 0; k < LINKS.length; k++) {
    var e3 = await sendComment(page, LINKS[k]);
    if (!/Ссылки в комментариях не публикуем/.test(e3)) slipped.push(LINKS[k] + ' → «' + e3 + '»');
  }
  var afterLinks = (await (await db('comments?select=id&photo_id=eq.' + PHOTO_A.id)).json());
  ok('8. Ссылка в комментарии не проходит',
     slipped.length === 0 && afterLinks.length === planted.length,
     slipped.length ? 'просочилось: ' + slipped.join('; ') : 'проверено ' + LINKS.length + ' написаний');

  /* === 9. Жалобы: две не прячут, три прячут ============================== */
  await page.goto(when(NORMAL));
  await feedReady(page);
  await page.waitForSelector(cardSel, { timeout: 15000 });

  await page.click(cardSel + ' .act-report');        // подтверждение принимает sayYes
  await page.waitForTimeout(1500);
  var afterOne = await photoState(PHOTO_A.id);

  var againSame = await rpcAs('add_report', { p_secret: ME.secret, p_photo_id: PHOTO_A.id });
  var afterSame = await photoState(PHOTO_A.id);
  ok('9а. Одна жалоба от одного гостя — вторая от него же не считается',
     afterOne && afterOne.reports === 1 && afterOne.hidden === false &&
     againSame && againSame.already === true && afterSame.reports === 1,
     'после первой ' + JSON.stringify(afterOne) + ', повтор → ' + JSON.stringify(againSame));

  await rpcAs('add_report', { p_secret: MATE.secret, p_photo_id: PHOTO_A.id });
  var afterTwo = await photoState(PHOTO_A.id);
  await page.goto(when(NORMAL));
  await feedReady(page);
  var stillInFeed = await page.waitForSelector(cardSel, { timeout: 15000 }).catch(function () { return null; });
  ok('9б. Две жалобы фото не прячут — оно осталось в ленте',
     afterTwo && afterTwo.reports === 2 && afterTwo.hidden === false && !!stillInFeed,
     'жалоб ' + (afterTwo && afterTwo.reports) + ', скрыто: ' + (afterTwo && afterTwo.hidden) +
     ', карточка в ленте: ' + !!stillInFeed);

  // третья — от третьего гостя, и уже через саму страницу
  await rpcAs('add_report', { p_secret: MATE.secret, p_photo_id: PHOTO_B.id });
  await rpcAs('add_report', { p_secret: MATE2.secret, p_photo_id: PHOTO_B.id });
  var beforeThird = await photoState(PHOTO_B.id);

  var cardB = '#feed .card[data-id="' + PHOTO_B.id + '"]';
  await page.waitForSelector(cardB, { timeout: 15000 });
  await snap(page, '04-do-tretej-zhaloby.png');
  await page.click(cardB + ' .act-report');
  await page.waitForTimeout(2000);

  var afterThree = await reportProbe(MATE.secret, PHOTO_B.id);
  var readable = await photoState(PHOTO_B.id);
  var goneFromFeed = !(await page.$(cardB));
  await snap(page, '05-skrytoe-foto.png');

  // и после перезагрузки его в ленте нет
  await page.goto(when(NORMAL));
  await feedReady(page);
  var goneAfterReload = !(await page.$(cardB));

  // и в карточке гостя тоже
  await page.click('#btn-me');
  await page.waitForSelector('#s-guest.is-on', { timeout: 10000 });
  await page.waitForTimeout(1500);
  var goneFromGuest = !(await page.$('#guest-grid .cell[data-id="' + PHOTO_B.id + '"]'));

  ok('9в. Третья жалоба от третьего гостя прячет фото из ленты и карточки гостя',
     beforeThird && beforeThird.reports === 2 && beforeThird.hidden === false &&
     afterThree && afterThree.reports === 3 && afterThree.hidden === true &&
     readable === null && goneFromFeed && goneAfterReload && goneFromGuest,
     'до третьей ' + JSON.stringify(beforeThird) + ', после ' + JSON.stringify(afterThree) +
     ', публичным ключом больше не читается: ' + (readable === null) +
     ', пропало сразу: ' + goneFromFeed + ', после перезагрузки: ' + goneAfterReload +
     ', в карточке гостя: ' + goneFromGuest);

  /* Снимок не удалён, а именно спрятан — ждёт разбора в панели этапа 6.
     У стёртой строки программа жалоб ответила бы no_photo; она же отвечает
     числом жалоб и признаком скрытия, значит запись на месте. */
  ok('9г. Скрытый снимок не удалён — запись цела и ждёт разбора',
     afterThree && afterThree.ok === true && afterThree.error !== 'no_photo',
     afterThree ? ('база о нём знает: жалоб ' + afterThree.reports + ', hidden = ' + afterThree.hidden)
                : 'ответа нет');

  /* === 10. Забаненный гость ============================================= */
  var banLike = await rpcAs('toggle_like', { p_secret: BANNED.secret, p_photo_id: PHOTO_A.id });
  var banSay = await rpcAs('add_comment', { p_secret: BANNED.secret, p_photo_id: PHOTO_A.id, p_body: 'привет' });
  var banFlag = await rpcAs('add_report', { p_secret: BANNED.secret, p_photo_id: PHOTO_A.id });
  var banLikes = await likeRows(PHOTO_A.id, BANNED.id);

  var banPage = await ctx.newPage();
  banPage.on('pageerror', function (e) { console.log('  !! ошибка на странице: ' + e.message); });
  await seed(banPage, BANNED);
  await banPage.goto(when(NORMAL));
  await banPage.waitForSelector('#s-blocked.is-on', { timeout: 20000 }).catch(function () {});
  var banScreen = await banPage.evaluate(function () {
    var s = document.querySelector('.screen.is-on');
    return s ? s.id : '';
  });
  await banPage.close();

  ok('10. Забаненный гость не лайкает, не комментирует и не жалуется',
     banLike && banLike.ok === false && banLike.error === 'no_guest' &&
     banSay && banSay.ok === false && banSay.error === 'no_guest' &&
     banFlag && banFlag.ok === false && banFlag.error === 'no_guest' &&
     banLikes.length === 0 && banScreen === 's-blocked',
     'лайк ' + JSON.stringify(banLike) + ', комментарий ' + JSON.stringify(banSay) +
     ', жалоба ' + JSON.stringify(banFlag) + ', экран «' + banScreen + '»');

  /* === 11. Ключ гостя наружу не уходит =================================== */
  var inMarkup = await page.evaluate(function (secret) {
    return document.documentElement.outerHTML.indexOf(secret) !== -1;
  }, ME.secret);

  ok('11. Ключ secret есть только в вызовах программ базы и не попал в разметку',
     leaks.length === 0 && !inMarkup,
     leaks.length ? leaks.slice(0, 3).join(' | ')
                  : 'нарушений нет, в разметке ключа нет');

  /* === 12. Строка действий и превью комментариев в самой ленте =========== */
  await page.goto(when(NORMAL));
  await feedReady(page);
  await page.waitForSelector(cardSel, { timeout: 15000 });
  var look = await page.evaluate(function (id) {
    var card = document.querySelector('#feed .card[data-id="' + id + '"]');
    if (!card) return null;
    var acts = card.querySelector('.acts');
    var talk = card.querySelector('.talk');
    return {
      like: !!acts.querySelector('.act-like'),
      talkBtn: !!acts.querySelector('.act-talk'),
      report: (acts.querySelector('.act-report') || {}).textContent || '',
      reportRight: acts.querySelector('.act-report').getBoundingClientRect().right >
                   acts.querySelector('.act-talk').getBoundingClientRect().right,
      lines: talk.querySelectorAll('.talk-line').length,
      all: (talk.querySelector('.talk-all') || {}).textContent || ''
    };
  }, PHOTO_A.id);

  ok('12. Под фото: сердце, значок комментариев, «Пожаловаться» справа, два последних и «показать все N»',
     !!look && look.like && look.talkBtn && look.report === 'Пожаловаться' && look.reportRight &&
     look.lines === 2 && /^Показать все \d+ коммент/.test(look.all),
     look ? ('строк комментариев ' + look.lines + ', строка «' + look.all + '»') : 'карточка не найдена');
  await snap(page, '06-lenta-s-kommentariyami.png');

  /* === 13. Окно приёма на месте ========================================== */
  var settingsNow = await (await db('settings?select=key,value&key=eq.window_start')).json();
  var startNow = settingsNow[0] && settingsNow[0].value;
  ok('13. Окно приёма не сдвинуто: window_start там же, где и было',
     Date.parse(startNow) === Date.parse(WINDOW_START),
     'в базе ' + startNow + ', ждали ' + WINDOW_START);

  /* --- итог --- */
  await matePage.close();
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

main().catch(function (e) {
  console.error('Проверки сорвались: ' + (e && e.stack || e));
  process.exit(2);
});
