/* ============================================================================
   ПАНЕЛЬ ВЛАДЕЛЬЦА · ЭТАП 6

   Сайт статический: серверных обработчиков нет и переменных среды нет, класть
   пароль некуда. Поэтому проверка живёт целиком в базе.

   Секрет приезжает в хеше ссылки: /panel/#k=... . Хеш браузер на сервер не
   отправляет — он не попадает ни в журнал веб-сервера, ни в заголовок Referer.
   Здесь секрет только в памяти страницы и уходит первым доводом в каждую
   admin_-программу базы. Каждая из них начинается со сверки SHA-256 с
   отпечатком в settings; не совпало — ответ 401 «forbidden» и ни байта данных.

   Публичный ключ Supabase лежит открыто и здесь, и в гостевой части — так и
   задумано: сам по себе он не даёт ни менять чужие строки, ни удалять их.
   ============================================================================ */

var CONFIG = {
  SUPABASE_URL: 'https://hwnmqcvvdlfqscoufyki.supabase.co',
  SUPABASE_KEY: 'sb_publishable_UQtVcMc-DoTEFFvDKE0mxQ_PV5nCSnn',
  PHOTO_BUCKET: 'photos',
  TIMEOUT_MS: 15000,
  STATS_MS: 30000,        // цифры обновляются раз в полминуты
  FIND_MS: 350,           // пауза после набора в поиске
  PAGE_SHOTS: 24,         // снимков в блоке удаления за раз
  PAGE_COMMENTS: 15,
  GUESTS_SHOWN: 10        // столько гостей видно без поиска и без «показать всех»
};

/* Секрет панели. Заполняется один раз при входе и больше нигде не хранится:
   ни в localStorage, ни в адресной строке помимо хеша. */
var KEY = null;

/* --------------------------------------------------------------------------
   Мелкие помощники
   -------------------------------------------------------------------------- */

function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function photoUrl(path) {
  return CONFIG.SUPABASE_URL + '/storage/v1/object/public/' +
         CONFIG.PHOTO_BUCKET + '/' + path;
}

/* Склонение: 3 фото, 1 фото, 5 фото — слово не меняется, меняются жалобы */
function plural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

var toastTimer = null;

function toast(text) {
  var t = el('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
}

function fetchTimed(url, opts) {
  var o = opts || {};
  var ctrl = ('AbortController' in window) ? new AbortController() : null;
  if (ctrl) o.signal = ctrl.signal;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, CONFIG.TIMEOUT_MS);
  return fetch(url, o).then(
    function (r) { clearTimeout(timer); return r; },
    function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? 'сеть не ответила' : (e && e.message) || String(e));
    }
  );
}

function dbHeaders() {
  return {
    apikey: CONFIG.SUPABASE_KEY,
    Authorization: 'Bearer ' + CONFIG.SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

/* Обычное чтение публичной витрины: лента, комментарии, гости.
   Всё это и так открыто гостям, отдельных прав тут не нужно. */
function restGet(path) {
  return fetchTimed(CONFIG.SUPABASE_URL + '/rest/v1/' + path, {
    headers: dbHeaders(), cache: 'no-store'
  }).then(function (r) {
    if (!r.ok) throw new Error('rest ' + r.status);
    return r.json();
  });
}

/* Команда панели. Секрет подставляется здесь, чтобы его нельзя было забыть
   ни в одном вызове. Отказ базы (401/403) отличаем от обрыва сети: по первому
   надо закрывать панель, по второму — просто повторить позже. */
function rpc(name, args) {
  var body = { p_key: KEY };
  if (args) Object.keys(args).forEach(function (k) { body[k] = args[k]; });

  return fetchTimed(CONFIG.SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: dbHeaders(),
    body: JSON.stringify(body)
  }).then(function (r) {
    if (r.status === 401 || r.status === 403) throw { forbidden: true };
    if (!r.ok) return r.text().then(function (t) { throw new Error(name + ': ' + r.status + ' ' + t); });
    return r.status === 204 ? null : r.json();
  });
}

/* --------------------------------------------------------------------------
   Окно подтверждения
   -------------------------------------------------------------------------- */

var askYes = null;

function ask(text, label, onYes) {
  el('ask-text').textContent = text;
  el('ask-yes').textContent = label;
  askYes = onYes;
  el('ask').hidden = false;
}

function askClose() {
  el('ask').hidden = true;
  askYes = null;
  var picked = document.querySelector('.p-tile.is-picked');
  if (picked) picked.classList.remove('is-picked');
}

/* --------------------------------------------------------------------------
   Блок 1. Рубильник
   -------------------------------------------------------------------------- */

/* Границы окна приёма. Читаются из тех же настроек, что и у гостей: панель
   должна говорить владельцу правду о том, что увидит гость, а не о том,
   что записано в рубильнике. */
var bounds = {
  window_start: '2026-08-06T12:00:00+03:00',
  window_end:   '2026-08-07T12:00:00+03:00',
  readonly_end: '2026-08-08T00:00:00+03:00'
};

var uploadOn = true;

function loadBounds() {
  return restGet('settings?select=key,value').then(function (rows) {
    (rows || []).forEach(function (row) {
      if (row && row.key in bounds && row.value) bounds[row.key] = row.value;
    });
  }).catch(function () { /* останутся запасные значения */ });
}

function siteState() {
  var t = Date.now();
  if (t < Date.parse(bounds.window_start)) return 'before';
  if (t < Date.parse(bounds.window_end))   return 'open';
  if (t < Date.parse(bounds.readonly_end)) return 'readonly';
  return 'closed';
}

function whenText(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: 'Europe/Moscow'
    }).format(d);
  } catch (e) { return iso; }
}

function drawSwitch() {
  var box = el('sw-box');
  box.classList.toggle('is-off', !uploadOn);

  el('sw-state').textContent = uploadOn ? 'Приём фото включён' : 'Приём остановлен';

  var go = el('sw-go');
  go.textContent = uploadOn ? 'Остановить' : 'Включить';
  go.className = 'btn ' + (uploadOn ? 'btn-solid' : 'btn-ghost');

  /* Рубильник сильнее окна только в одну сторону. Выключенный закрывает приём
     даже посреди праздника; включённый не открывает его раньше срока. Про это
     легко забыть, поэтому панель пишет прямо. */
  var st = siteState();
  var note;
  if (!uploadOn) {
    note = 'Гости не могут загружать фото, даже если окно приёма открыто.';
  } else if (st === 'before') {
    note = 'Загрузка всё равно закрыта: окно приёма откроется ' +
           whenText(bounds.window_start) + '.';
  } else if (st === 'open') {
    note = 'Гости могут загружать фото до ' + whenText(bounds.window_end) + '.';
  } else if (st === 'readonly') {
    note = 'Окно приёма закрылось ' + whenText(bounds.window_end) +
           '. Лента только для чтения.';
  } else {
    note = 'Сайт закрыт, у гостей осталась страница благодарности.';
  }
  el('sw-note').textContent = note;
}

function switchTap() {
  var go = el('sw-go');
  var next = !uploadOn;
  go.disabled = true;

  rpc('admin_set_upload', { p_enabled: next })
    .then(function (res) {
      uploadOn = !!(res && String(res.upload_enabled) === 'true');
      drawSwitch();
      toast(uploadOn ? 'Приём фото включён' : 'Приём остановлен');
    })
    .catch(fail)
    .then(function () { go.disabled = false; });
}

/* --------------------------------------------------------------------------
   Блок 2. Жалобы
   -------------------------------------------------------------------------- */

function loadReports() {
  return rpc('admin_reports_list').then(function (rows) {
    rows = rows || [];
    var box = el('rp-list');
    el('rp-none').hidden = rows.length > 0;
    box.innerHTML = '';

    rows.forEach(function (r) {
      var n = r.reports || 0;
      var row = document.createElement('div');
      row.className = 'p-row';
      row.dataset.id = r.id;
      row.innerHTML =
        '<img class="p-shot" src="' + esc(photoUrl(r.preview_path)) + '" alt="" loading="lazy">' +
        '<div class="p-row-body">' +
          '<p class="p-nick">' + esc(r.nick) +
            (r.banned ? '<span class="p-flag">БАН</span>' : '') + '</p>' +
          '<p class="p-meta">' + n + ' ' + plural(n, 'жалоба', 'жалобы', 'жалоб') + '</p>' +
          '<div class="p-acts">' +
            '<button class="btn btn-ghost" data-act="restore">Вернуть в ленту</button>' +
            '<button class="btn btn-solid" data-act="kill">Удалить навсегда</button>' +
          '</div>' +
        '</div>';

      row.querySelector('[data-act="restore"]').addEventListener('click', function () {
        row.classList.add('p-busy');
        rpc('admin_photo_restore', { p_photo: r.id }).then(function (res) {
          if (res && res.ok === false) { toast('Снимка уже нет'); }
          else if (res && res.hidden) { toast('Жалобы сняты, но автор забанен — снимок остался скрытым'); }
          else { toast('Снимок вернулся в ленту'); }
          refresh();
        }).catch(fail).then(function () { row.classList.remove('p-busy'); });
      });

      row.querySelector('[data-act="kill"]').addEventListener('click', function () {
        ask('Удалить снимок гостя ' + r.nick + ' навсегда? Вернуть его будет нельзя.',
            'Удалить', function () {
          row.classList.add('p-busy');
          killPhoto(r.id).then(function () { row.classList.remove('p-busy'); });
        });
      });

      box.appendChild(row);
    });
  });
}

function killPhoto(id) {
  return rpc('admin_photo_delete', { p_photo: id }).then(function (res) {
    /* Про файл говорим прямо. Supabase не даёт стирать файлы запросом из базы,
       поэтому превью остаётся лежать в хранилище ничьим — из ленты снимок
       при этом уходит навсегда. */
    if (res && res.ok === false) toast('Снимка уже нет');
    else if (res && res.file === false) toast('Снимок удалён, файл превью остался в хранилище');
    else toast('Снимок удалён');
    refresh();
  }).catch(fail);
}

/* --------------------------------------------------------------------------
   Блок 3. Гости
   -------------------------------------------------------------------------- */

var findTimer = null;
var guestsAll = false;   // показывать ли весь список целиком

function loadGuests() {
  var q = el('gu-find').value.trim();

  return rpc('admin_guests_list', { p_search: q || null }).then(function (rows) {
    rows = rows || [];
    var box = el('gu-list');
    el('gu-none').hidden = rows.length > 0;
    box.innerHTML = '';

    /* Гостей будет полторы сотни, и почти у всех ноль снимков. Разворачивать
       такой список на весь экран нельзя: до блока с цифрами пришлось бы
       листать минуту. База отдаёт его отсортированным — сперва забаненные,
       потом самые снимающие, — поэтому сверху всегда те, ради кого сюда
       и заходят. Остальные достаются поиском или кнопкой. */
    var more = 0;
    if (!guestsAll && !q && rows.length > CONFIG.GUESTS_SHOWN) {
      more = rows.length - CONFIG.GUESTS_SHOWN;
      rows = rows.slice(0, CONFIG.GUESTS_SHOWN);
    }
    el('gu-more').hidden = more === 0;
    if (more) el('gu-more').textContent = 'Показать всех (ещё ' + more + ')';

    rows.forEach(function (g) {
      var n = g.photos || 0;
      var row = document.createElement('div');
      row.className = 'p-row';
      row.dataset.id = g.id;
      row.innerHTML =
        '<div class="p-row-body">' +
          '<p class="p-nick">' + esc(g.nick) +
            (g.banned ? '<span class="p-flag">БАН</span>' : '') + '</p>' +
          '<p class="p-meta">' + n + ' ' + plural(n, 'фото', 'фото', 'фото') + '</p>' +
          '<div class="p-acts">' +
            '<button class="btn ' + (g.banned ? 'btn-ghost' : 'btn-solid') + '" data-act="ban">' +
              (g.banned ? 'Разбанить' : 'Забанить') + '</button>' +
          '</div>' +
        '</div>';

      row.querySelector('[data-act="ban"]').addEventListener('click', function () {
        if (g.banned) {
          row.classList.add('p-busy');
          rpc('admin_unban', { p_guest: g.id }).then(function (res) {
            toast('Гость ' + g.nick + ' разбанен, снимков вернулось: ' + ((res && res.photos) || 0));
            refresh();
          }).catch(fail).then(function () { row.classList.remove('p-busy'); });
          return;
        }
        ask('Забанить гостя ' + g.nick + '? Все его снимки скроются, вход закроется.',
            'Забанить', function () {
          row.classList.add('p-busy');
          rpc('admin_ban', { p_guest: g.id }).then(function (res) {
            toast('Гость ' + g.nick + ' забанен, снимков скрыто: ' + ((res && res.photos) || 0));
            refresh();
          }).catch(fail).then(function () { row.classList.remove('p-busy'); });
        });
      });

      box.appendChild(row);
    });
  });
}

/* --------------------------------------------------------------------------
   Блок 4. Цифры
   -------------------------------------------------------------------------- */

function loadStats() {
  return rpc('admin_stats').then(function (s) {
    if (!s) return;
    el('st-photos').textContent = s.photos;
    el('st-guests').textContent = s.guests;
    el('st-hour').textContent   = s.photos_hour;
    el('st-hidden').textContent = s.hidden;

    /* Рубильник читаем отсюда же: одна поездка в базу вместо двух, и цифры
       с состоянием кнопки не разъезжаются. */
    var was = uploadOn;
    uploadOn = String(s.upload_enabled) === 'true';
    if (was !== uploadOn || el('sw-state').textContent === '…') drawSwitch();
  });
}

function loadTop() {
  return rpc('admin_top_likes').then(function (rows) {
    rows = (rows || []).filter(function (r) { return (r.likes || 0) > 0; });
    var box = el('st-top');
    el('st-top-none').hidden = rows.length > 0;
    box.innerHTML = '';

    rows.forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'p-top5-item';
      item.innerHTML =
        '<img src="' + esc(photoUrl(r.preview_path)) + '" alt="" loading="lazy">' +
        '<p class="p-top5-line"><b>' + r.likes + '</b> <span>' + esc(r.nick) + '</span></p>';
      box.appendChild(item);
    });
  });
}

/* --------------------------------------------------------------------------
   Блок 5. Удаление любого фото и любого комментария

   Списки читаются обычным публичным запросом: и лента, и комментарии открыты
   гостям, показывать их панели нечем не хуже. Удаление же идёт только через
   admin_-программы, то есть только с секретом.
   -------------------------------------------------------------------------- */

var nicks = {};       // id гостя -> ник
var shotsShown = 0;
var cmShown = 0;

function loadNicks() {
  return restGet('guests_public?select=id,nick').then(function (rows) {
    (rows || []).forEach(function (g) { nicks[g.id] = g.nick; });
  }).catch(function () { /* без ников список всё равно работает */ });
}

function nickOf(id) { return nicks[id] || '—'; }

function loadShots(more) {
  shotsShown = more ? shotsShown + CONFIG.PAGE_SHOTS : CONFIG.PAGE_SHOTS;
  var lim = shotsShown;

  return restGet('photos?select=id,guest_id,preview_path,created_at' +
                 '&order=created_at.desc&limit=' + (lim + 1))
    .then(function (rows) {
      rows = rows || [];
      var hasMore = rows.length > lim;
      if (hasMore) rows = rows.slice(0, lim);

      var box = el('rm-grid');
      el('rm-none').hidden = rows.length > 0;
      el('rm-more').hidden = !hasMore;
      box.innerHTML = '';

      rows.forEach(function (p) {
        var nick = nickOf(p.guest_id);
        var tile = document.createElement('button');
        tile.className = 'p-tile';
        tile.type = 'button';
        tile.dataset.id = p.id;
        tile.innerHTML =
          '<img src="' + esc(photoUrl(p.preview_path)) + '" alt="" loading="lazy">' +
          '<span class="p-tile-nick">' + esc(nick) + '</span>';

        tile.addEventListener('click', function () {
          tile.classList.add('is-picked');
          ask('Удалить снимок гостя ' + nick + ' навсегда? Вернуть его будет нельзя.',
              'Удалить', function () { killPhoto(p.id); });
        });

        box.appendChild(tile);
      });
    });
}

function loadComments(more) {
  cmShown = more ? cmShown + CONFIG.PAGE_COMMENTS : CONFIG.PAGE_COMMENTS;
  var lim = cmShown;

  return restGet('comments?select=id,guest_id,body,created_at' +
                 '&order=created_at.desc&limit=' + (lim + 1))
    .then(function (rows) {
      rows = rows || [];
      var hasMore = rows.length > lim;
      if (hasMore) rows = rows.slice(0, lim);

      var box = el('cm-list');
      el('cm-none').hidden = rows.length > 0;
      el('cm-more').hidden = !hasMore;
      box.innerHTML = '';

      rows.forEach(function (c) {
        var nick = nickOf(c.guest_id);
        var row = document.createElement('div');
        row.className = 'p-row';
        row.dataset.id = c.id;
        row.innerHTML =
          '<div class="p-row-body">' +
            '<p class="p-nick">' + esc(nick) + '</p>' +
            '<p class="p-text">' + esc(c.body) + '</p>' +
            '<div class="p-acts">' +
              '<button class="btn btn-ghost" data-act="del">Удалить</button>' +
            '</div>' +
          '</div>';

        row.querySelector('[data-act="del"]').addEventListener('click', function () {
          ask('Удалить комментарий гостя ' + nick + '?', 'Удалить', function () {
            row.classList.add('p-busy');
            rpc('admin_comment_delete', { p_comment: c.id }).then(function (res) {
              toast(res && res.ok === false ? 'Комментария уже нет' : 'Комментарий удалён');
              loadComments(false);
            }).catch(fail).then(function () { row.classList.remove('p-busy'); });
          });
        });

        box.appendChild(row);
      });
    });
}

/* --------------------------------------------------------------------------
   Общее обновление и разбор ошибок
   -------------------------------------------------------------------------- */

function fail(e) {
  if (e && e.forbidden) { deny(); return; }
  toast('Не получилось: ' + ((e && e.message) || 'база не ответила'));
}

function deny() {
  clearInterval(statsTimer);
  KEY = null;
  el('p-body').hidden = true;
  el('ask').hidden = true;
  el('p-deny').hidden = false;
}

/* Полное обновление после любого действия: одно действие меняет сразу
   несколько блоков — бан прячет фото и меняет цифры, удаление меняет и
   жалобы, и топ. Перерисовываем всё, списки короткие. */
function refresh() {
  if (!KEY) return Promise.resolve();
  return Promise.all([
    loadStats(), loadTop(), loadReports(), loadGuests(), loadShots(false), loadComments(false)
  ]).catch(fail);
}

var statsTimer = null;

/* --------------------------------------------------------------------------
   Вход
   -------------------------------------------------------------------------- */

function keyFromHash() {
  var m = /(?:^|[#&])k=([^&]+)/.exec(location.hash || '');
  if (!m) return null;
  var v;
  try { v = decodeURIComponent(m[1]); } catch (e) { v = m[1]; }
  v = v.trim();
  return v || null;
}

/* То же, что и на гостевой части: страница не масштабируется щипком.
   Двойной тап останавливает touch-action в общем styles.css. Пультом
   пользуются стоя и одной рукой — случайное увеличение здесь дороже всего. */
function killZoom() {
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
    document.addEventListener(name, function (e) { e.preventDefault(); }, { passive: false });
  });
}

function boot() {
  killZoom();

  el('ask-no').addEventListener('click', askClose);
  el('ask-back').addEventListener('click', askClose);
  el('ask-yes').addEventListener('click', function () {
    var fn = askYes;
    askClose();
    if (fn) fn();
  });

  var k = keyFromHash();
  if (!k) { el('p-deny').hidden = false; return; }   // «Нет доступа», больше ничего

  /* Пока секрет не сверен, ни один список не грузится: первый и единственный
     запрос — admin_ping. Отказ означает, что ссылка не та. */
  KEY = k;
  fetchTimed(CONFIG.SUPABASE_URL + '/rest/v1/rpc/admin_ping', {
    method: 'POST', headers: dbHeaders(), body: JSON.stringify({ p_key: KEY })
  }).then(function (r) {
    if (!r.ok) { deny(); return; }

    el('p-deny').hidden = true;
    el('p-body').hidden = false;

    el('sw-go').addEventListener('click', switchTap);
    el('p-refresh').addEventListener('click', function () { refresh(); toast('Обновлено'); });
    el('rm-more').addEventListener('click', function () { loadShots(true).catch(fail); });
    el('cm-more').addEventListener('click', function () { loadComments(true).catch(fail); });

    el('gu-find').addEventListener('input', function () {
      clearTimeout(findTimer);
      findTimer = setTimeout(function () { loadGuests().catch(fail); }, CONFIG.FIND_MS);
    });

    el('gu-more').addEventListener('click', function () {
      guestsAll = true;
      loadGuests().catch(fail);
    });

    loadBounds()
      .then(loadNicks)
      .then(refresh)
      .then(function () { drawSwitch(); });

    /* Цифры сами обновляются раз в полминуты, перезагружать нечего */
    statsTimer = setInterval(function () {
      Promise.all([loadStats(), loadTop()]).catch(fail);
    }, CONFIG.STATS_MS);
  }).catch(function () {
    deny();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
