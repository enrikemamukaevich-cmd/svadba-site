/* ============================================================================
   СВАДЕБНЫЙ ФОТОСАЙТ · ЭТАП 2 · вход и регистрация
   Чистый JavaScript без библиотек. С базой говорим обычным fetch:
   пин никогда не считается и не сверяется в браузере — браузер шлёт ник и пин
   в базу, база отвечает да или нет. Скрытый ключ гостя secret живёт только
   в памяти браузера и в ленту не попадает.
   ============================================================================ */

var CONFIG = {
  SUPABASE_URL: 'https://hwnmqcvvdlfqscoufyki.supabase.co',
  SUPABASE_KEY: 'sb_publishable_UQtVcMc-DoTEFFvDKE0mxQ_PV5nCSnn',
  FN_URL: '/panel.php',          // появится на этапе 6
  CODE_WORD: 'любовь',
  AVATAR_BUCKET: 'avatars',
  AVATAR_SIDE: 400,
  AVATAR_QUALITY: 0.86,
  LOGIN_TRIES: 3,
  LOGIN_PAUSE_MS: 60000,
  TIMEOUT_MS: 15000,
  PHOTO_BUCKET: 'photos',
  PAGE: 12,              // сколько карточек в одной порции
  POLL_MS: 30000,        // как часто спрашиваем базу про новые фото

  /* --- загрузка фото ---
     Цель по весу превью — 150 КБ, а не 250: полторы тысячи снимков по 250 КБ
     съедают бесплатное место в Supabase к ночи свадьбы. 250 КБ — уже потолок,
     выше которого файл не уходит ни при каком качестве. */
  UP_DIR: 'feed',                  // боевая папка в бакете, тестовая test/ не трогается
  UP_MAX_FILES: 10,
  UP_MAX_BYTES: 25 * 1024 * 1024,
  UP_SIDE: 1440,                   // длинная сторона превью
  UP_SIDE_TIGHT: 1152,             // запасная, если и грубое качество не уложилось
  UP_TARGET_BYTES: 150 * 1024,
  UP_HARD_BYTES: 250 * 1024,
  UP_TRIES: 3,                     // попыток на один файл
  UP_TIMEOUT_MS: 45000,            // отправка тяжелее чтения, срок ожидания длиннее

  /* --- лайки, комментарии, жалобы --- */
  CM_MAX: 200,                     // знаков в комментарии
  CM_PREVIEW: 2,                   // сколько последних видно прямо в ленте
  REPORTS_HIDE: 3,                 // на какой жалобе снимок прячется (решает база)

  /* --- жесты --- */
  TAP_MS: 300,                     // порог между касаниями двойного тапа
  TAP_SLOP: 14,                    // сдвиг пальца, после которого это уже прокрутка
  SHEET_MS: 280,                   // доводка шторки после отпускания
  SHEET_CLOSE_PART: 0.33,          // уехала больше трети — закрывается
  SHEET_FLING: 0.5                 // точек за миллисекунду: рывок закрывает сразу
};

var STORE_GUEST = 'svadba.guest';
var STORE_LOGIN = 'svadba.login';

/* --------------------------------------------------------------------------
   Мелкие помощники
   -------------------------------------------------------------------------- */

function el(id) { return document.getElementById(id); }
function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

/* Единственная дверь на любой экран. После 8 августа сайта нет — что бы ни
   попросили показать, остаётся страница благодарности. Проверка стоит здесь,
   а не в десяти местах: иначе запоздавший ответ сети снова откроет ленту. */
function show(id) {
  if (id !== 's-closed' && siteState() === 'closed') id = 's-closed';
  all('.screen').forEach(function (s) { s.classList.toggle('is-on', s.id === id); });
  window.scrollTo(0, 0);
}

function setErr(id, text) {
  var node = el(id);
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('is-on', !!text);
}

function clearErrs() {
  all('.err').forEach(function (n) { n.textContent = ''; n.classList.remove('is-on'); });
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = label || 'Подождите…';
    btn.disabled = true;
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = false;
  }
}

// Третьим доводом можно задать свой срок ожидания: отправка снимка идёт дольше
// чтения ленты, и общие пятнадцать секунд для неё коротки.
function fetchTimed(url, opts, ms) {
  var o = opts || {};
  var ctrl = ('AbortController' in window) ? new AbortController() : null;
  if (ctrl) o.signal = ctrl.signal;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || CONFIG.TIMEOUT_MS);
  return fetch(url, o).then(
    function (r) { clearTimeout(timer); return r; },
    function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? 'сеть не ответила' : (e && e.message) || String(e));
    }
  );
}

/* --------------------------------------------------------------------------
   База
   -------------------------------------------------------------------------- */

function dbHeaders(extra) {
  var h = {
    apikey: CONFIG.SUPABASE_KEY,
    Authorization: 'Bearer ' + CONFIG.SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}

// Вызов готовой программы внутри базы
function rpc(name, params) {
  return fetchTimed(CONFIG.SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: dbHeaders(),
    body: JSON.stringify(params || {})
  }).then(function (r) {
    return r.text().then(function (t) {
      if (!r.ok) throw new Error('база ответила ' + r.status);
      try { return JSON.parse(t); } catch (e) { return t; }
    });
  });
}

function restGet(path, extraHeaders) {
  return fetchTimed(CONFIG.SUPABASE_URL + '/rest/v1/' + path, {
    headers: dbHeaders(extraHeaders)
  });
}

// Сколько фото уже загружено — берём из заголовка content-range, тела не нужно
function photoCount() {
  return restGet('photos?select=id', { Prefer: 'count=exact', Range: '0-0' })
    .then(function (r) {
      var cr = r.headers.get('content-range') || '';
      var n = parseInt(cr.split('/')[1], 10);
      return isNaN(n) ? null : n;
    })
    .catch(function () { return null; });
}

// Витрина guests_public пин-кодов и ключей не содержит — оттуда только banned
function isBanned(id) {
  return restGet('guests_public?select=banned&id=eq.' + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(function (rows) { return !!(rows && rows[0] && rows[0].banned); })
    .catch(function () { return false; });
}

function avatarUrl(kind, value) {
  if (kind === 'custom' && value) {
    return CONFIG.SUPABASE_URL + '/storage/v1/object/public/' + CONFIG.AVATAR_BUCKET + '/' + value;
  }
  var n = parseInt(value, 10);
  if (!(n >= 1 && n <= 6)) n = 1;
  return 'img/avatar-' + n + '.svg';
}

function uploadAvatar(blob) {
  var name = 'custom/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.jpg';
  return fetchTimed(CONFIG.SUPABASE_URL + '/storage/v1/object/' + CONFIG.AVATAR_BUCKET + '/' + name, {
    method: 'POST',
    headers: {
      apikey: CONFIG.SUPABASE_KEY,
      Authorization: 'Bearer ' + CONFIG.SUPABASE_KEY,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'false'
    },
    body: blob
  }).then(function (r) {
    if (!r.ok) throw new Error('хранилище ответило ' + r.status);
    return name;
  });
}

/* --------------------------------------------------------------------------
   Память браузера
   -------------------------------------------------------------------------- */

function saveGuest(g) {
  try {
    localStorage.setItem(STORE_GUEST, JSON.stringify({
      id: g.id, nick: g.nick, avatar_kind: g.avatar_kind, avatar_value: g.avatar_value, secret: g.secret
    }));
  } catch (e) { /* приватный режим — переживём */ }
}

function loadGuest() {
  try { return JSON.parse(localStorage.getItem(STORE_GUEST) || 'null'); }
  catch (e) { return null; }
}

function forgetGuest() {
  try { localStorage.removeItem(STORE_GUEST); } catch (e) { /* всё равно */ }
}

/* --------------------------------------------------------------------------
   Проверки полей
   -------------------------------------------------------------------------- */

var NICK_RE = /^[A-Za-zА-Яа-яЁё0-9._-]{2,20}$/;

function nickError(nick) {
  if (!nick) return 'Впишите никнейм.';
  if (nick.length < 2) return 'Слишком короткий ник, нужно хотя бы два знака.';
  if (nick.length > 20) return 'Слишком длинный ник, не больше двадцати знаков.';
  if (!NICK_RE.test(nick)) return 'В нике можно только буквы, цифры, точку, дефис и подчёркивание.';
  // тот же фильтр, что и у комментариев: грубый ник виден всей ленте под каждым фото
  if (isLink(nick)) return 'Ник не должен быть похож на адрес сайта.';
  if (isRude(nick)) return 'Так не пойдёт. Придумайте ник без грубых слов.';
  return '';
}

function normWord(s) {
  return String(s || '').trim().toLowerCase().replace(/ё/g, 'е');
}

function wordOk(s) {
  return normWord(s) === normWord(CONFIG.CODE_WORD);
}

/* --------------------------------------------------------------------------
   Фильтр грубости и ссылок

   Живёт в браузере: серверных обработчиков на хостинге нет, а ловить надо
   до того, как грубость увидят гости. Обойти его теоретически можно —
   это разбирается на этапе 8, здесь задача проще: не пустить обычного
   человека, который пишет сгоряча и слегка маскирует слово.

   Порядок разбора один и тот же для комментария и для никнейма:
     1. нижний регистр;
     2. латинские и цифровые двойники русских букв — обратно в кириллицу
        («xyй» и «6лядь» узнаются наравне с обычным написанием);
     3. «ё» к «е»;
     4. вон всё, что не буква, — точки и звёздочки внутри слова больше
        не прячут корень;
     5. повторы букв в одну — «сууука» становится «сука».

   Дальше корень ищется не где попало, а с начала слова или сразу после
   обычной русской приставки. Без этого фильтр становится жадным и рубит
   «стрАХОВка», «оскорБЛЯть», «хЛЕБАТь», «барСУКА». Сверх того есть короткий
   список заведомо мирных начал слова — они не разбираются вовсе.
   -------------------------------------------------------------------------- */

// Двойники: похожие начертанием латинские буквы и цифры
var TWINS = {
  a: 'а', b: 'б', c: 'с', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'н', i: 'и',
  j: 'й', k: 'к', l: 'л', m: 'м', n: 'п', o: 'о', p: 'р', q: 'я', r: 'г',
  s: 'с', t: 'т', u: 'и', v: 'в', w: 'ш', x: 'х', y: 'у', z: 'з',
  '0': 'о', '1': 'и', '3': 'з', '4': 'ч', '6': 'б', '9': 'я'
};

function squeeze(s) {
  return String(s || '').toLowerCase()
    .replace(/[a-z0-9]/g, function (ch) { return TWINS[ch] || ch; })
    .replace(/ё/g, 'е')
    .replace(/[^а-я]/g, '')
    .replace(/(.)\1+/g, '$1');
}

// Слова исходного текста, каждое приведено к тому же виду
function words(s) {
  return String(s || '').split(/[^0-9A-Za-zА-Яа-яЁё]+/)
    .map(squeeze)
    .filter(function (w) { return !!w; });
}

/* Корни. Намеренно длиннее, чем «еб» или «бля»: короткий корень ловит
   пол-словаря даже с проверкой приставки. */
var ROOTS = [
  'хуй', 'хуе', 'хуя', 'хую', 'хуи',
  'пизд', 'пезд',
  'ебат', 'ебал', 'ебан', 'ебуч', 'ебош', 'ебуш', 'ебл', 'ебис', 'ебыр', 'ебот', 'ебыв',
  'выеб', 'заеб', 'наеб', 'уеб', 'съеб', 'подъеб', 'объеб', 'разъеб', 'отъеб',
  'доеб', 'приеб', 'проеб',
  'долбое', 'долбае',
  'бля',
  /* Гласную выбивают звёздочкой чаще всего: «бл*ть», «п*зда», «х*й».
     Звёздочка уже вылетела при разборе, буквы обратно не вернуть — поэтому
     держим и обглоданные корни. Сочетаний «блт», «блд», «пзд», «хй»
     в русских словах не бывает, ложных срабатываний они не дают. */
  'блт', 'блд', 'пзд', 'хй',
  'сука', 'суки', 'суке', 'суку', 'сучк', 'сучар', 'сцук',
  'мудак', 'мудач', 'мудил', 'мудох', 'мудоз', 'мудло',
  'гандон', 'гондон', 'залуп', 'дроч', 'шлюх', 'шлюш', 'мандав',
  'пидор', 'пидар', 'пидр', 'пидер', 'педик',
  'херн', 'херов', 'херач',
  'говн', 'говен', 'жоп', 'срак', 'срал', 'сран', 'ссыкл', 'дерьм', 'курва',
  'трахн', 'трахат', 'трахал'
];

// Обычные русские приставки. Пустая строка — корень с самого начала слова.
var PREFIX = [
  '', 'в', 'вз', 'вы', 'до', 'за', 'из', 'изъ', 'на', 'над', 'не', 'ни',
  'о', 'об', 'объ', 'от', 'отъ', 'пере', 'по', 'под', 'подъ', 'пре', 'при',
  'про', 'раз', 'разъ', 'рас', 'с', 'со', 'съ', 'у'
];

/* Мирные начала слов. Список короткий и держится на одном правиле:
   сюда попадает то, что иначе разобьётся о корень выше. */
var SAFE = [
  'страх', 'пасажир', 'объектив', 'объект', 'блокнот', 'сучок', 'сучек',
  'барсук', 'скипидар', 'хлеб', 'колеб', 'погреб', 'гребат', 'гребл',
  'оскорб', 'употреб', 'истреб', 'ослаб', 'услаб', 'углуб', 'требов',
  'потреб', 'наблюд', 'обляп', 'оглобл', 'корабл', 'рубл', 'грабл', 'сабл',
  'команд', 'мандарин', 'мудр', 'изумруд', 'трахе', 'сукно', 'посуд', 'побед'
];

function isSafeWord(w) {
  for (var i = 0; i < SAFE.length; i++) {
    if (w.indexOf(SAFE[i]) === 0) return true;
  }
  return false;
}

// Корень засчитывается, только если слева от него начало слова или приставка
function rootIn(word) {
  for (var i = 0; i < ROOTS.length; i++) {
    var at = word.indexOf(ROOTS[i]);
    while (at !== -1) {
      if (PREFIX.indexOf(word.slice(0, at)) !== -1) return ROOTS[i];
      at = word.indexOf(ROOTS[i], at + 1);
    }
  }
  return '';
}

/* Слово смотрим целиком, а потом ещё раз — склеенным с соседями.
   «х.у.й» и «х у й» разваливаются на однобуквенные обрывки, поодиночке в них
   ничего не видно. Склеиваем только подряд идущие куски не длиннее трёх букв:
   склей мы всё подряд, «с ранами» стало бы бранью, а «ты х.у.й» — наоборот,
   перестало бы ею быть, потому что корень оказался бы не в начале слова. */
var GLUE_MAX = 3;      // длина обрывка, который считаем частью разорванного слова
var GLUE_LIMIT = 24;   // дальше склеивать бессмысленно

function isRude(s) {
  var list = words(s);
  for (var i = 0; i < list.length; i++) {
    if (!isSafeWord(list[i]) && rootIn(list[i])) return true;
    if (list[i].length > GLUE_MAX) continue;

    var glue = list[i];
    for (var j = i + 1; j < list.length && list[j].length <= GLUE_MAX; j++) {
      glue += list[j];
      if (glue.length > GLUE_LIMIT) break;
      if (!isSafeWord(glue) && rootIn(glue)) return true;
    }
  }
  return false;
}

/* Ссылки. Под свадебными фото не должно появиться чужой рекламы, поэтому
   отсекаем и явный адрес, и просто «что-то.ru». Проверяем ещё и текст
   без пробелов — «пример . ру» пишется и так. */
var TLD = 'ru|рф|ру|su|com|net|org|info|biz|io|me|co|cc|tv|app|dev|pro|name|' +
          'xyz|online|site|store|shop|club|top|life|link|space|fun|team|' +
          'ua|by|kz|am|ge|tk|gg';
var LINK_WORD_RE = /(^|[^а-яa-z])(https?|www)([^а-яa-z]|$)/i;
var DOMAIN_RE = new RegExp('[a-zа-яё0-9-]+\\.(' + TLD + ')(?![a-zа-яё0-9])', 'i');

function isLink(s) {
  var t = String(s || '');
  if (LINK_WORD_RE.test(t) || /https?:\/\//i.test(t)) return true;
  return DOMAIN_RE.test(t) || DOMAIN_RE.test(t.replace(/\s+/g, ''));
}

var RUDE_TEXT = 'Давайте без грубостей. Перепишите, пожалуйста';
var LINK_TEXT = 'Ссылки в комментариях не публикуем';

// Одна причина, по которой комментарий сейчас не уйдёт, или пустая строка
function commentError(s) {
  var body = String(s || '').trim();
  if (!body) return 'Напишите что-нибудь, пустой комментарий не отправляется';
  if (body.length > CONFIG.CM_MAX) {
    return 'Слишком длинно: ' + body.length + ' знаков из ' + CONFIG.CM_MAX;
  }
  if (isLink(body)) return LINK_TEXT;
  if (isRude(body)) return RUDE_TEXT;
  return '';
}

/* --------------------------------------------------------------------------
   Пин-код: четыре клетки с автопереходом
   -------------------------------------------------------------------------- */

function wirePin(rootId, onFull) {
  var cells = all('.pin-cell', el(rootId));

  cells.forEach(function (cell, i) {
    cell.addEventListener('input', function () {
      var digits = cell.value.replace(/\D/g, '');
      if (digits.length > 1) {           // вставили сразу несколько цифр
        spread(digits, i);
        return;
      }
      cell.value = digits;
      if (digits && i < cells.length - 1) cells[i + 1].focus();
      if (digits && i === cells.length - 1 && onFull && pinValue(rootId).length === 4) onFull();
    });

    cell.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !cell.value && i > 0) {
        e.preventDefault();
        cells[i - 1].value = '';
        cells[i - 1].focus();
      }
      if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); cells[i - 1].focus(); }
      if (e.key === 'ArrowRight' && i < cells.length - 1) { e.preventDefault(); cells[i + 1].focus(); }
    });

    cell.addEventListener('paste', function (e) {
      var text = (e.clipboardData || window.clipboardData).getData('text') || '';
      var digits = text.replace(/\D/g, '');
      if (!digits) return;
      e.preventDefault();
      spread(digits, i);
    });

    cell.addEventListener('focus', function () { cell.select(); });
  });

  function spread(digits, from) {
    for (var k = 0; k < digits.length && from + k < cells.length; k++) {
      cells[from + k].value = digits[k];
    }
    var last = Math.min(from + digits.length, cells.length - 1);
    cells[last].focus();
    if (onFull && pinValue(rootId).length === 4) onFull();
  }
}

function pinValue(rootId) {
  return all('.pin-cell', el(rootId)).map(function (c) { return c.value.replace(/\D/g, ''); }).join('');
}

function pinClear(rootId) {
  all('.pin-cell', el(rootId)).forEach(function (c) { c.value = ''; });
}

/* --------------------------------------------------------------------------
   Экран 1. Старт
   -------------------------------------------------------------------------- */

function startScreen() {
  show('s-start');
  photoCount().then(function (n) {
    el('photo-count').textContent = 'Загружено фото: ' + (n === null ? '—' : n);
  });
}

/* --------------------------------------------------------------------------
   Экран 2. Регистрация
   -------------------------------------------------------------------------- */

var draft = { nick: '', pin: '', avatar_kind: 'preset', avatar_value: '1' };

function regNext() {
  clearErrs();
  var nick = el('reg-nick').value.trim();
  var word = el('reg-word').value;
  var pin = pinValue('reg-pin');
  var bad = false;

  var ne = nickError(nick);
  if (ne) { setErr('err-nick', ne); bad = true; }

  if (!wordOk(word)) { setErr('err-word', 'Слово не подходит. Спросите у ведущего'); bad = true; }

  if (!/^\d{4}$/.test(pin)) { setErr('err-pin', 'Пин-код — ровно четыре цифры.'); bad = true; }

  if (bad) return;

  var btn = el('reg-next');
  busy(btn, true, 'Проверяем…');

  rpc('nick_free', { p_nick: nick }).then(function (free) {
    busy(btn, false);
    if (free === false) {
      setErr('err-nick', 'Этот ник уже взяли, придумайте другой');
      return;
    }
    draft.nick = nick;
    draft.pin = pin;
    show('s-avatar');
  }).catch(function (e) {
    busy(btn, false);
    setErr('err-nick', 'Не получилось проверить ник: ' + e.message + '. Попробуйте ещё раз.');
  });
}

/* --------------------------------------------------------------------------
   Экран 3. Аватар
   -------------------------------------------------------------------------- */

function pickAvatar(btn) {
  all('.ava').forEach(function (a) { a.classList.remove('is-picked'); });
  btn.classList.add('is-picked');
  draft.avatar_kind = btn.dataset.kind;
  draft.avatar_value = btn.dataset.value || '';
  setErr('err-avatar', '');
}

function regFinish() {
  clearErrs();
  var btn = el('reg-finish');

  if (draft.avatar_kind === 'custom' && !customBlob) {
    setErr('err-avatar', 'Своё фото не подготовилось, выберите картинку.');
    return;
  }

  busy(btn, true, 'Заходим…');

  var prepared = (draft.avatar_kind === 'custom')
    ? uploadAvatar(customBlob)
    : Promise.resolve(draft.avatar_value);

  prepared.then(function (value) {
    return rpc('register_guest', {
      p_nick: draft.nick,
      p_pin: draft.pin,
      p_avatar_kind: draft.avatar_kind,
      p_avatar_value: String(value)
    });
  }).then(function (res) {
    busy(btn, false);
    if (!res || res.ok !== true) {
      var code = res && res.error;
      if (code === 'nick_taken') {
        show('s-reg');
        setErr('err-nick', 'Этот ник уже взяли, придумайте другой');
      } else if (code === 'pin_format') {
        show('s-reg');
        setErr('err-pin', 'Пин-код — ровно четыре цифры.');
      } else if (code === 'nick_format') {
        show('s-reg');
        setErr('err-nick', 'В нике можно только буквы, цифры, точку, дефис и подчёркивание.');
      } else {
        setErr('err-avatar', 'Не получилось зарегистрироваться. Попробуйте ещё раз.');
      }
      return;
    }
    saveGuest(res);
    enterFeed(res);
  }).catch(function (e) {
    busy(btn, false);
    setErr('err-avatar', 'Не получилось зарегистрироваться: ' + e.message);
  });
}

/* --------------------------------------------------------------------------
   Своё фото: поворот по метаданным съёмки, круглое окно, щипок и перетаскивание
   -------------------------------------------------------------------------- */

var customBlob = null;   // готовый JPEG 400×400
var crop = null;         // состояние экрана подгонки

// Читаем ориентацию из блока EXIF. Ничего не нашли — считаем, что поворота нет.
function exifOrientation(file) {
  return Promise.resolve().then(function () {
    if (!file.slice || !Blob.prototype.arrayBuffer) return null;
    return file.slice(0, 128 * 1024).arrayBuffer();
  }).then(function (buf) {
    if (!buf) return 1;
    var v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0, false) !== 0xFFD8) return 1;
    var off = 2;
    while (off + 4 <= v.byteLength) {
      if (v.getUint8(off) !== 0xFF) { off++; continue; }
      var marker = v.getUint8(off + 1);
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) break;
      var size = v.getUint16(off + 2, false);
      if (marker === 0xE1 && off + 10 <= v.byteLength && v.getUint32(off + 4, false) === 0x45786966) {
        var tiff = off + 10;
        if (tiff + 8 > v.byteLength) return 1;
        var le = v.getUint16(tiff, false) === 0x4949;
        var ifd = tiff + v.getUint32(tiff + 4, le);
        if (ifd + 2 > v.byteLength) return 1;
        var count = v.getUint16(ifd, le);
        for (var i = 0; i < count; i++) {
          var entry = ifd + 2 + i * 12;
          if (entry + 12 > v.byteLength) break;
          if (v.getUint16(entry, le) === 0x0112) {
            var o = v.getUint16(entry + 8, le);
            return (o >= 1 && o <= 8) ? o : 1;
          }
        }
        return 1;
      }
      off += 2 + size;
    }
    return 1;
  }).catch(function () { return 1; });
}

// Раскодировать картинку так, как её видит браузер
function decodeImage(blob) {
  if (window.createImageBitmap) {
    return createImageBitmap(blob).then(function (bm) {
      return { src: bm, w: bm.width, h: bm.height };
    });
  }
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () { URL.revokeObjectURL(url); resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('не читается')); };
    img.src = url;
  });
}

/* Одни браузеры сами разворачивают снимок по метаданным, другие нет.
   Гадать нельзя: развернём дважды — фото ляжет набок. Поэтому один раз
   собираем крошечный снимок с пометкой «повёрнут» и смотрим, что вышло. */
var autoRotateAnswer = null;
function browserAutoRotates() {
  if (autoRotateAnswer) return autoRotateAnswer;
  autoRotateAnswer = probeJpeg().then(decodeImage).then(function (got) {
    return got.w < got.h;               // 4×2 стал 2×4 — значит браузер повернул сам
  }).catch(function () { return false; });
  return autoRotateAnswer;
}

function probeJpeg() {
  return new Promise(function (resolve, reject) {
    var c = document.createElement('canvas');
    c.width = 4; c.height = 2;
    var x = c.getContext('2d');
    x.fillStyle = '#888'; x.fillRect(0, 0, 4, 2);
    c.toBlob(function (b) { b ? resolve(b) : reject(new Error('нет JPEG')); }, 'image/jpeg', 0.5);
  }).then(function (b) {
    return b.arrayBuffer();
  }).then(function (buf) {
    var src = new Uint8Array(buf);
    // блок APP1 с единственной пометкой: ориентация 6 (повернуть на 90°)
    var app1 = new Uint8Array([
      0xFF, 0xE1, 0x00, 0x22,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00
    ]);
    var out = new Uint8Array(src.length + app1.length);
    out.set(src.subarray(0, 2), 0);
    out.set(app1, 2);
    out.set(src.subarray(2), 2 + app1.length);
    return new Blob([out], { type: 'image/jpeg' });
  });
}

// Возвращает холст, на котором снимок уже стоит правильной стороной вверх.
// Заодно ужимаем: снимок с телефона на двенадцать мегапикселей целиком в память
// старого айфона не лезет, а для кружка четыреста на четыреста столько и не нужно.
var MAX_SIDE = 1600;

// Вторым доводом задаётся длинная сторона: кружку аватара хватает 1600,
// превью в ленте ужимается до 1440.
function normalizedCanvas(file, maxSide) {
  var limit = maxSide || MAX_SIDE;
  return Promise.all([exifOrientation(file), decodeImage(file), browserAutoRotates()])
    .then(function (r) {
      var orient = r[0], got = r[1], auto = r[2];
      if (auto) orient = 1;                       // браузер уже развернул
      var turned = (orient >= 5 && orient <= 8);
      var k = Math.min(1, limit / Math.max(got.w, got.h));
      var c = document.createElement('canvas');
      c.width = Math.round((turned ? got.h : got.w) * k);
      c.height = Math.round((turned ? got.w : got.h) * k);
      var x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.scale(k, k);                              // сжатие первым, развороты поверх него
      switch (orient) {
        case 2: x.transform(-1, 0, 0, 1, got.w, 0); break;
        case 3: x.transform(-1, 0, 0, -1, got.w, got.h); break;
        case 4: x.transform(1, 0, 0, -1, 0, got.h); break;
        case 5: x.transform(0, 1, 1, 0, 0, 0); break;
        case 6: x.transform(0, 1, -1, 0, got.h, 0); break;
        case 7: x.transform(0, -1, -1, 0, got.h, got.w); break;
        case 8: x.transform(0, -1, 1, 0, 0, got.w); break;
      }
      x.drawImage(got.src, 0, 0);
      if (got.src.close) got.src.close();
      return c;
    });
}

function openCrop(file) {
  setErr('err-avatar', '');
  Promise.resolve().then(function () { return normalizedCanvas(file); }).then(function (c) {
    show('s-crop');
    var stage = el('crop-stage');
    var side = Math.round(stage.getBoundingClientRect().width) || 320;
    var hole = Math.round(side * 0.78);
    el('crop-hole').style.width = hole + 'px';
    el('crop-hole').style.height = hole + 'px';

    var canvas = el('crop-canvas');
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);

    crop = {
      img: c, iw: c.width, ih: c.height,
      side: side, hole: hole, dpr: dpr,
      ctx: canvas.getContext('2d'),
      s: 1, tx: 0, ty: 0,
      minS: hole / Math.min(c.width, c.height)
    };
    crop.s = crop.minS;
    clampCrop();
    drawCrop();
  }).catch(function (e) {
    setErr('err-avatar', 'Не получилось открыть снимок: ' + e.message);
  });
}

function clampCrop() {
  if (!crop) return;
  if (crop.s < crop.minS) crop.s = crop.minS;
  if (crop.s > crop.minS * 8) crop.s = crop.minS * 8;
  var maxX = (crop.iw * crop.s - crop.hole) / 2;
  var maxY = (crop.ih * crop.s - crop.hole) / 2;
  crop.tx = Math.max(-maxX, Math.min(maxX, crop.tx));
  crop.ty = Math.max(-maxY, Math.min(maxY, crop.ty));
}

function drawCrop() {
  if (!crop) return;
  var x = crop.ctx, S = crop.side;
  x.setTransform(crop.dpr, 0, 0, crop.dpr, 0, 0);
  x.clearRect(0, 0, S, S);
  x.fillStyle = '#000';
  x.fillRect(0, 0, S, S);
  var w = crop.iw * crop.s, h = crop.ih * crop.s;
  x.drawImage(crop.img, S / 2 + crop.tx - w / 2, S / 2 + crop.ty - h / 2, w, h);
}

function cropToBlob() {
  var R = crop.hole / 2;
  var u = (-R - crop.tx) / crop.s + crop.iw / 2;
  var v = (-R - crop.ty) / crop.s + crop.ih / 2;
  var box = crop.hole / crop.s;
  var out = document.createElement('canvas');
  out.width = CONFIG.AVATAR_SIDE;
  out.height = CONFIG.AVATAR_SIDE;
  var x = out.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, CONFIG.AVATAR_SIDE, CONFIG.AVATAR_SIDE);
  x.drawImage(crop.img, u, v, box, box, 0, 0, CONFIG.AVATAR_SIDE, CONFIG.AVATAR_SIDE);
  return new Promise(function (resolve, reject) {
    out.toBlob(function (b) { b ? resolve(b) : reject(new Error('не пересохранился')); },
      'image/jpeg', CONFIG.AVATAR_QUALITY);
  });
}

// Жесты пишем руками: одним пальцем двигаем, двумя приближаем.
function wireCropGestures() {
  var stage = el('crop-stage');
  var drag = null, pinch = null;

  function pointFrom(t) { return { x: t.clientX, y: t.clientY }; }

  stage.addEventListener('touchstart', function (e) {
    if (!crop) return;
    e.preventDefault();
    if (e.touches.length === 1) {
      drag = pointFrom(e.touches[0]);
      pinch = null;
    } else if (e.touches.length >= 2) {
      drag = null;
      pinch = twoFingers(e.touches);
    }
  }, { passive: false });

  stage.addEventListener('touchmove', function (e) {
    if (!crop) return;
    e.preventDefault();
    if (e.touches.length === 1 && drag) {
      var p = pointFrom(e.touches[0]);
      crop.tx += p.x - drag.x;
      crop.ty += p.y - drag.y;
      drag = p;
    } else if (e.touches.length >= 2) {
      var now = twoFingers(e.touches);
      if (pinch) {
        zoomAt(now.d / pinch.d, now.x, now.y);
        crop.tx += now.x - pinch.x;
        crop.ty += now.y - pinch.y;
      }
      pinch = now;
    }
    clampCrop();
    drawCrop();
  }, { passive: false });

  stage.addEventListener('touchend', function (e) {
    if (e.touches.length === 0) { drag = null; pinch = null; }
    else if (e.touches.length === 1) { drag = pointFrom(e.touches[0]); pinch = null; }
  });

  function twoFingers(touches) {
    var a = touches[0], b = touches[1];
    return {
      d: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2
    };
  }

  // Мышью — то же самое: тянем и крутим колесо. Нужно для проверок на компьютере.
  stage.addEventListener('mousedown', function (e) {
    if (!crop) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', function (e) {
    if (!crop || !drag) return;
    crop.tx += e.clientX - drag.x;
    crop.ty += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    clampCrop();
    drawCrop();
  });
  window.addEventListener('mouseup', function () { drag = null; });

  stage.addEventListener('wheel', function (e) {
    if (!crop) return;
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, r.left + r.width / 2, r.top + r.height / 2);
    clampCrop();
    drawCrop();
  }, { passive: false });

  // приближаем так, чтобы точка под пальцами осталась на месте
  function zoomAt(k, cx, cy) {
    var r = stage.getBoundingClientRect();
    var ox = cx - (r.left + r.width / 2);
    var oy = cy - (r.top + r.height / 2);
    var before = crop.s;
    crop.s = crop.s * k;
    clampCrop();
    var real = crop.s / before;
    crop.tx = ox + (crop.tx - ox) * real;
    crop.ty = oy + (crop.ty - oy) * real;
  }
}

/* --------------------------------------------------------------------------
   Экран 4. Вход обратно
   -------------------------------------------------------------------------- */

var lockTimer = null;

function loginState() {
  var s;
  try { s = JSON.parse(localStorage.getItem(STORE_LOGIN) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') s = { fails: 0, until: 0 };
  return s;
}

function saveLoginState(s) {
  try { localStorage.setItem(STORE_LOGIN, JSON.stringify(s)); } catch (e) { /* переживём */ }
}

function refreshLogin() {
  var s = loginState();
  var btn = el('log-go');
  var left = Math.ceil((s.until - Date.now()) / 1000);

  if (left > 0) {
    btn.disabled = true;
    btn.textContent = 'Подождите ' + left + ' с';
    el('login-left').textContent = 'Слишком много попыток. Кнопка включится через ' + left + ' с.';
    if (!lockTimer) lockTimer = setInterval(refreshLogin, 1000);
    return;
  }

  if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
  if (s.until) { s.until = 0; s.fails = 0; saveLoginState(s); }
  btn.disabled = false;
  btn.textContent = 'Войти';
  el('login-left').textContent = 'Осталось попыток: ' + (CONFIG.LOGIN_TRIES - s.fails);
}

function loginGo() {
  clearErrs();
  var s = loginState();
  if (s.until > Date.now()) { refreshLogin(); return; }

  var nick = el('log-nick').value.trim();
  var pin = pinValue('log-pin');
  if (!nick || !/^\d{4}$/.test(pin)) {
    setErr('err-login', 'Неверный ник или пин');
    countFail();
    return;
  }

  var btn = el('log-go');
  busy(btn, true, 'Проверяем…');

  rpc('check_pin', { p_nick: nick, p_pin: pin }).then(function (res) {
    if (res && res.error === 'banned') {
      busy(btn, false);
      show('s-blocked');
      return;
    }
    if (!res || res.ok !== true) {
      busy(btn, false);
      setErr('err-login', 'Неверный ник или пин');
      pinClear('log-pin');
      countFail();
      if (!el('log-go').disabled) all('.pin-cell', el('log-pin'))[0].focus();
      return;
    }
    return isBanned(res.id).then(function (banned) {
      busy(btn, false);
      if (banned) { show('s-blocked'); return; }
      saveLoginState({ fails: 0, until: 0 });
      saveGuest(res);
      enterFeed(res);
    });
  }).catch(function (e) {
    busy(btn, false);
    setErr('err-login', 'Сеть не отвечает: ' + e.message);
  });
}

function countFail() {
  var s = loginState();
  s.fails = (s.fails || 0) + 1;
  if (s.fails >= CONFIG.LOGIN_TRIES) {
    s.until = Date.now() + CONFIG.LOGIN_PAUSE_MS;
    s.fails = CONFIG.LOGIN_TRIES;
  }
  saveLoginState(s);
  refreshLogin();
}

/* ==========================================================================
   ЛЕНТА
   ========================================================================== */

var me = null;                   // гость, который сейчас смотрит

/* --------------------------------------------------------------------------
   Время и состояния сайта
   -------------------------------------------------------------------------- */

// Боевые границы. Настоящие значения лежат в таблице settings, эти — запасные
// на случай, если база не ответит: сайт всё равно должен вести себя правильно.
var bounds = {
  window_start: '2026-08-06T12:00:00+03:00',
  window_end:   '2026-08-07T12:00:00+03:00',
  readonly_end: '2026-08-08T00:00:00+03:00'
};

/* Отладка состояний: ?now=2026-08-07T13:00:00+03:00 подменяет часы.
   Работает только с локального адреса — на боевом домене параметр не действует,
   иначе гость смог бы открыть загрузку раньше времени. */
function debugNow() {
  var h = location.hostname;
  if (!(h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '')) return null;
  var m = /[?&]now=([^&]*)/.exec(location.search);
  if (!m) return null;
  var t = Date.parse(decodeURIComponent(m[1]));
  return isNaN(t) ? null : t;
}

function nowMs() {
  var d = debugNow();
  return d === null ? Date.now() : d;
}

function siteState() {
  var t = nowMs();
  if (t < Date.parse(bounds.window_start)) return 'before';
  if (t < Date.parse(bounds.window_end))   return 'open';
  if (t < Date.parse(bounds.readonly_end)) return 'readonly';
  return 'closed';
}

/* Рубильник приёма фото. Значение в таблице лежит текстом, но владелец мог
   переключить его и логическим типом — принимаем оба вида. */
var uploadOn = true;

function truthy(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  var s = String(v).trim().toLowerCase();
  return !(s === '' || s === 'false' || s === '0' || s === 'off' || s === 'нет');
}

/* Настройки читаются не один раз при входе, а перед каждой отправкой снимка:
   гость мог открыть страницу до полудня и нажать «плюс» вечером, а владелец —
   выключить приём посреди праздника. Заголовок no-cache нужен, чтобы браузер
   не отдал ответ, лежащий у него с прошлого раза. */
function readSettings() {
  return restGet('settings?select=key,value', { 'Cache-Control': 'no-cache' })
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      (rows || []).forEach(function (row) {
        if (!row) return;
        if (row.key in bounds && row.value) bounds[row.key] = row.value;
        if (row.key === 'upload_enabled') uploadOn = truthy(row.value);
      });
      return true;
    })
    .catch(function () { return false; });   // останутся прежние значения
}

function loadBounds() {
  return readSettings();
}

/* --------------------------------------------------------------------------
   Мелкие помощники ленты
   -------------------------------------------------------------------------- */

function photoUrl(path) {
  return CONFIG.SUPABASE_URL + '/storage/v1/object/public/' + CONFIG.PHOTO_BUCKET + '/' + path;
}

/* Пропорции снимка зашиты в имя файла: ...-1200x1600.jpg. Отдельных полей
   под ширину и высоту в таблице нет, а место под фото надо занять до того,
   как оно приедет, иначе лента прыгает. */
var SIZE_RE = /-(\d{2,5})x(\d{2,5})\.[a-z0-9]+$/i;

function shotRatio(path) {
  var m = SIZE_RE.exec(path || '');
  if (!m) return null;
  var w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  return (w > 0 && h > 0) ? (w + ' / ' + h) : null;
}

var fmtTime = null;

function hhmm(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    if (!fmtTime) fmtTime = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Moscow'
    });
    return fmtTime.format(d);
  } catch (e) {
    var m = new Date(d.getTime() + 3 * 3600 * 1000);   // Москва без Intl
    return ('0' + m.getUTCHours()).slice(-2) + ':' + ('0' + m.getUTCMinutes()).slice(-2);
  }
}

var toastTimer = null;

function toast(text) {
  var t = el('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
}

/* --------------------------------------------------------------------------
   Гости: витрину читаем один раз и держим под рукой
   -------------------------------------------------------------------------- */

var guestMap = {};

function loadGuests() {
  return restGet('guests_public?select=id,nick,avatar_kind,avatar_value,created_at')
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      (rows || []).forEach(function (g) { guestMap[g.id] = g; });
      return guestMap;
    })
    .catch(function () { return guestMap; });
}

function guestOf(id) {
  if (guestMap[id]) return guestMap[id];
  if (me && me.id === id) return me;      // себя знаем и без витрины
  return { id: id, nick: 'гость', avatar_kind: 'preset', avatar_value: '1', created_at: null };
}

/* Витрину читаем один раз, а гости регистрируются и во время праздника.
   Если в порции попался незнакомый автор — перечитываем список, иначе
   вместо ника у него будет стоять безликое «гость». */
function ensureGuests(rows) {
  var unknown = rows.some(function (r) { return !guestMap[r.guest_id]; });
  return unknown ? loadGuests() : Promise.resolve(guestMap);
}

function ensureGuest(id) {
  if (guestMap[id]) return Promise.resolve(guestMap[id]);
  return restGet('guests_public?select=id,nick,avatar_kind,avatar_value,created_at&id=eq.' + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      if (rows && rows[0]) { guestMap[rows[0].id] = rows[0]; return rows[0]; }
      return guestOf(id);
    })
    .catch(function () { return guestOf(id); });
}

/* --------------------------------------------------------------------------
   Запросы ленты
   -------------------------------------------------------------------------- */

// Считаем через content-range: тело ответа не нужно, только число
function countPhotos(extra) {
  return restGet('photos?select=id&hidden=eq.false' + (extra || ''), { Prefer: 'count=exact', Range: '0-0' })
    .then(function (r) {
      var n = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
      return isNaN(n) ? 0 : n;
    });
}

/* id.desc — запасной порядок: если у двух снимков совпало время, страницы
   не должны разъезжаться при подгрузке.

   Числа лайков и комментариев и два последних комментария приезжают тем же
   запросом, что и сама порция: база умеет считать связанные записи и тут же
   отдавать их кусок. Двенадцать карточек стоят одного обращения, а не
   двенадцати и не двух. */
var PAGE_SELECT = 'id,guest_id,preview_path,created_at,' +
                  'likes(count),comments(count),last:comments(id,guest_id,body,created_at)';

// guestId задаётся, когда лента показывает снимки одного человека
function fetchPage(offset, limit, guestId) {
  return restGet('photos?select=' + PAGE_SELECT +
                 '&hidden=eq.false&order=created_at.desc,id.desc' +
                 (guestId ? '&guest_id=eq.' + encodeURIComponent(guestId) : '') +
                 '&offset=' + offset + '&limit=' + limit +
                 '&last.order=created_at.desc&last.limit=' + CONFIG.CM_PREVIEW)
    .then(function (r) { return r.json(); });
}

function likesTotal(photoIds) {
  if (!photoIds.length) return Promise.resolve(0);
  return restGet('likes?select=photo_id&photo_id=in.(' + photoIds.join(',') + ')',
                 { Prefer: 'count=exact', Range: '0-0' })
    .then(function (r) {
      var n = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
      return isNaN(n) ? 0 : n;
    })
    .catch(function () { return 0; });
}

/* --------------------------------------------------------------------------
   Сборка карточки
   -------------------------------------------------------------------------- */

function cardNode(row) {
  var g = guestOf(row.guest_id);
  photoRow[row.id] = row;

  var card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = row.id;

  var top = document.createElement('div');
  top.className = 'card-top';

  var who = document.createElement('button');
  who.className = 'card-who';
  who.type = 'button';
  who.addEventListener('click', function () { openGuest(row.guest_id, true); });

  var ava = document.createElement('span');
  ava.className = 'card-ava';
  var avaImg = document.createElement('img');
  avaImg.src = avatarUrl(g.avatar_kind, g.avatar_value);
  avaImg.alt = '';
  ava.appendChild(avaImg);

  var nick = document.createElement('b');
  nick.className = 'card-nick';
  nick.textContent = g.nick;

  who.appendChild(ava);
  who.appendChild(nick);

  var time = document.createElement('time');
  time.className = 'card-time';
  time.dateTime = row.created_at;
  time.textContent = hhmm(row.created_at);

  top.appendChild(who);
  top.appendChild(time);

  var shot = document.createElement('div');
  shot.className = 'card-shot';
  var ratio = shotRatio(row.preview_path);
  shot.style.aspectRatio = ratio || '4 / 5';

  var img = document.createElement('img');
  img.alt = 'Снимок гостя ' + g.nick;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('load', function () {
    // размеров в имени не было — берём настоящие, чтобы не было серых полей
    if (!ratio && img.naturalWidth && img.naturalHeight) {
      shot.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
    }
    shot.classList.add('is-ready');
  });
  img.addEventListener('error', function () { shot.classList.add('is-ready'); });
  img.src = photoUrl(row.preview_path);
  shot.appendChild(img);

  // большое сердце для двойного тапа: лежит здесь всегда и всегда невидимо
  var pop = document.createElement('span');
  pop.className = 'pop';
  pop.appendChild(icon([D_HEART]));
  shot.appendChild(pop);

  wireDoubleTap(shot, function () { likeByTap(row.id); });

  card.appendChild(top);
  card.appendChild(shot);
  card.appendChild(actsNode(row));
  card.appendChild(talkNode(row));
  paintIn(card, row.id);          // карточки ещё нет в разметке — красим на месте
  return card;
}

/* Одиночный тап по фотографии не делает ничего, поэтому ждать второго касания
   и гадать не нужно: лайк срабатывает мгновенно на втором. Отличаем тап от
   прокрутки по сдвигу пальца — с пальцем на фото лента листается свободно
   и случайных лайков не ставит. Зум по двойному тапу снят через touch-action
   в оформлении. */
function wireDoubleTap(node, onDouble) {
  var start = null, lastAt = 0, lastX = 0, lastY = 0;

  node.addEventListener('pointerdown', function (e) {
    start = { x: e.clientX, y: e.clientY, t: Date.now() };
  }, { passive: true });

  node.addEventListener('pointercancel', function () { start = null; }, { passive: true });

  node.addEventListener('pointerup', function (e) {
    if (!start) return;
    var moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    var held = Date.now() - start.t;
    start = null;
    if (moved > CONFIG.TAP_SLOP || held > 700) { lastAt = 0; return; }   // это прокрутка

    var now = Date.now();
    var near = Math.hypot(e.clientX - lastX, e.clientY - lastY) < 44;
    if (lastAt && now - lastAt < CONFIG.TAP_MS && near) {
      lastAt = 0;
      onDouble();
      return;
    }
    lastAt = now; lastX = e.clientX; lastY = e.clientY;
  }, { passive: true });
}

// Серые прямоугольники на время загрузки очередной порции
function skeletonNode() {
  var card = document.createElement('article');
  card.className = 'card is-skeleton';
  card.innerHTML =
    '<div class="card-top">' +
      '<span class="card-ava"></span>' +
      '<span class="skel skel-nick"></span>' +
      '<span class="skel skel-time"></span>' +
    '</div>' +
    '<div class="card-shot"></div>';
  return card;
}

/* --------------------------------------------------------------------------
   Лента: состояние и подгрузка
   -------------------------------------------------------------------------- */

/* Лент две: общая и лента одного гостя, которая открывается с его карточки.
   Карточки, подгрузка и наблюдатель у них общие, поэтому состояние вынесено
   в отдельный объект, а не разложено по переменным. */
function makeFeed(listId, tailId) {
  return {
    listId: listId,
    tailId: tailId,
    guestId: null,    // не пусто — показываем снимки только этого гостя
    base: 0,          // с какого места в его списке начинаем
    offset: 0,
    done: false,
    busy: false,
    newest: null,     // время самого свежего показанного снимка
    waiting: 0,       // сколько новых чужих снимков ждёт за плашкой
    scrollY: 0,       // где оставили ленту, уходя на карточку гостя
    watcher: null,
    poller: null
  };
}

var feed = makeFeed('feed', 'feed-tail');        // общая
var gfeed = makeFeed('gfeed', 'gfeed-tail');     // одного гостя

function feedReset(f) {
  f.offset = 0;
  f.done = false;
  f.busy = false;
  f.newest = null;
  f.waiting = 0;
  el(f.listId).innerHTML = '';
  if (f === feed) {
    el('feed-empty').hidden = true;
    el('newbar').hidden = true;
  }
}

function feedRefreshCount() {
  return countPhotos().then(function (n) {
    el('feed-count').textContent = 'Всего фото: ' + n;
    return n;
  }).catch(function () {
    el('feed-count').textContent = 'Всего фото: —';
    return 0;
  });
}

function feedMore(f) {
  f = f || feed;
  if (f.busy || f.done) return Promise.resolve();
  f.busy = true;

  var list = el(f.listId);
  var skels = [];
  for (var i = 0; i < 3; i++) { var s = skeletonNode(); skels.push(s); list.appendChild(s); }

  return fetchPage(f.base + f.offset, CONFIG.PAGE, f.guestId).then(function (rows) {
    rows = rows || [];
    absorbStats(rows);
    /* Свои лайки — отдельный вызов: их не спросишь, не показав ключ гостя,
       а ключу не место в обычном запросе к таблице. Карточек он не задерживает
       и разметку не двигает — закрасит сердечки, когда придёт. */
    var ids = rows.map(function (r) { return r.id; });
    loadMyLikes(ids).then(function () {
      ids.forEach(function (id) { paintPhoto(id); });
    });
    return ensureGuests(rows.concat(talkAuthors(rows))).then(function () { return rows; });
  }).then(function (rows) {
    skels.forEach(function (s) { s.remove(); });

    rows.forEach(function (row) {
      list.appendChild(cardNode(row));
      if (!f.newest || row.created_at > f.newest) f.newest = row.created_at;
    });

    f.offset += rows.length;
    if (rows.length < CONFIG.PAGE) f.done = true;
    f.busy = false;

    if (f === feed) el('feed-empty').hidden = !(f.offset === 0 && f.done);

    // экран высокий, а порция короткая — досыпаем, пока не появится прокрутка
    if (!f.done && document.body.scrollHeight <= window.innerHeight + 40) return feedMore(f);
  }).catch(function () {
    skels.forEach(function (s) { s.remove(); });
    f.busy = false;
    if (f === feed) el('feed-count').textContent = 'Лента не загрузилась. Потяните вниз и обновите страницу.';
    else toast('Не получилось загрузить фото гостя');
  });
}

function feedWatch(f) {
  f = f || feed;
  if (f.watcher || !('IntersectionObserver' in window)) return;
  f.watcher = new IntersectionObserver(function (entries) {
    if (entries.some(function (e) { return e.isIntersecting; })) feedMore(f);
  }, { rootMargin: '400px 0px' });
  f.watcher.observe(el(f.tailId));
}

/* Новые чужие снимки сами не появляются — сверху всплывает плашка. */
function newWord(n) {
  return (n % 10 === 1 && n % 100 !== 11) ? 'новое фото' : 'новых фото';
}

function pollNew() {
  if (!feed.newest) return;
  var q = '&created_at=gt.' + encodeURIComponent(feed.newest);
  if (me && me.id) q += '&guest_id=neq.' + me.id;
  countPhotos(q).then(function (n) {
    feed.waiting = n;
    var bar = el('newbar');
    if (n > 0) {
      bar.textContent = n + ' ' + newWord(n) + ' — показать';
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
  }).catch(function () { /* сеть моргнула — попробуем через полминуты */ });
}

function feedReload() {
  feedReset(feed);
  feedRefreshCount();
  return feedMore(feed).then(function () { window.scrollTo(0, 0); });
}

/* Только что отправленный снимок встаёт в начало ленты сам, без перечитывания
   всех порций: гость отправляет десять штук подряд и должен видеть каждую
   сразу, а не ждать конца очереди. Сдвигаем и offset — иначе следующая порция
   вернёт снимок, который уже стоит на экране. */
function feedPrepend(row) {
  if (!row || !row.preview_path) return;
  var list = el('feed');
  if (list.querySelector('.card[data-id="' + row.id + '"]')) return;

  // снимок только что загружен — спрашивать базу о его лайках незачем
  stats[row.id] = { likes: 0, comments: 0, last: [] };
  liked[row.id] = false;

  var node = cardNode(row);
  var first = list.querySelector('.card:not(.is-skeleton)');
  if (first) list.insertBefore(node, first);
  else list.insertBefore(node, list.firstChild);

  feed.offset += 1;
  if (!feed.newest || row.created_at > feed.newest) feed.newest = row.created_at;
  el('feed-empty').hidden = true;

  var m = /(\d+)/.exec(el('feed-count').textContent || '');
  el('feed-count').textContent = 'Всего фото: ' + (m ? parseInt(m[1], 10) + 1 : 1);
}

function enterFeed(g) {
  me = g;
  el('me-img').src = avatarUrl(g.avatar_kind, g.avatar_value);
  el('me-img').alt = 'Моя карточка';

  if (applyState() === 'closed') return;
  show('s-feed');

  loadGuests().then(function () {
    return feedReload();
  }).then(function () {
    feedWatch(feed);
    if (!feed.poller) feed.poller = setInterval(pollNew, CONFIG.POLL_MS);
  });
}

/* --------------------------------------------------------------------------
   Состояния сайта на экране
   -------------------------------------------------------------------------- */

function applyState() {
  var st = siteState();

  if (st === 'closed') { show('s-closed'); return st; }

  var plus = el('btn-plus');
  plus.classList.toggle('is-off', st !== 'open' || !uploadOn);
  el('ribbon-readonly').hidden = (st !== 'readonly');
  return st;
}

/* Одна причина, по которой снимок сейчас не уйдёт, или пустая строка.
   Тексты про сроки — те же, что лента показывала и на этапе 3. */
var UP_OFF_TEXT = 'Загрузка сейчас выключена';

function uploadStop() {
  var st = siteState();
  if (st === 'before')   return 'Откроется 6 августа в 12:00';
  if (st === 'readonly') return 'Загрузка закрыта. Ленту можно смотреть до 8 августа';
  if (st === 'closed')   return 'closed';
  if (!uploadOn)         return UP_OFF_TEXT;
  return '';
}

function plusTap() {
  var stop = uploadStop();
  if (stop === 'closed') { applyState(); return; }
  if (stop) { toast(stop); return; }
  openUpload();
}

/* --------------------------------------------------------------------------
   Карточка гостя
   -------------------------------------------------------------------------- */

function fillGuestHead(g, mine) {
  el('guest-title').textContent = mine ? 'Моя карточка' : 'Гость';
  el('guest-face').src = avatarUrl(g.avatar_kind, g.avatar_value);
  el('guest-face').alt = '';
  el('guest-nick').textContent = g.nick;
}

/* Чья карточка открыта прямо сейчас. Пока идут запросы, гость успевает
   открыть другую — опоздавший ответ не должен затирать свежую. */
var shownGuest = null;
var guestScrollY = 0;             // где оставили карточку, уходя в ленту гостя
var guestShots = {};              // id гостя → его снимки по порядку

function openGuest(id, push) {
  var mine = !!(me && me.id === id);
  shownGuest = id;

  fillGuestHead(guestOf(id), mine);
  // гость мог зарегистрироваться уже после того, как мы прочитали витрину
  ensureGuest(id).then(function (g) { if (shownGuest === id) fillGuestHead(g, mine); });

  el('guest-photos').textContent = '—';
  el('guest-likes').textContent = '—';
  el('guest-grid').innerHTML = '';
  el('guest-none').hidden = true;
  el('guest-exit').hidden = !mine;      // на чужой карточке выхода нет вовсе

  // куда вернуть ленту, когда гость нажмёт «назад»
  if (el('s-feed').classList.contains('is-on')) feed.scrollY = window.scrollY;

  show('s-guest');
  if (push) {
    try { history.pushState({ guest: id }, '', location.href); } catch (e) { /* переживём */ }
  }

  restGet('photos?select=id,guest_id,preview_path,created_at&hidden=eq.false&guest_id=eq.' +
          encodeURIComponent(id) + '&order=created_at.desc,id.desc')
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      if (shownGuest !== id) return null;
      rows = rows || [];
      guestShots[id] = rows;
      el('guest-photos').textContent = rows.length;
      el('guest-none').hidden = rows.length > 0;

      var grid = el('guest-grid');
      rows.forEach(function (row) {
        grid.appendChild(cellNode(row, mine));
      });

      return likesTotal(rows.map(function (r) { return r.id; }));
    })
    .then(function (n) { if (n !== null && shownGuest === id) el('guest-likes').textContent = n; })
    .catch(function () {
      el('guest-photos').textContent = '—';
      el('guest-likes').textContent = '—';
    });
}

/* --------------------------------------------------------------------------
   Лента одного гостя

   Открывается снимком в его карточке. Порядок тот же, что в общей ленте,
   но фотографии только этого человека и начиная с выбранной: место выбранной
   в его списке и есть начало ленты. Лайки, комментарии и жалобы работают
   ровно так же — карточки собирает тот же cardNode.
   -------------------------------------------------------------------------- */

function openGuestFeed(guestId, photoId, push) {
  var list = guestShots[guestId] || [];
  var at = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === photoId) { at = i; break; }
  }

  if (el('s-guest').classList.contains('is-on')) guestScrollY = window.scrollY;

  gfeed.guestId = guestId;
  gfeed.base = at;
  feedReset(gfeed);

  el('gfeed-title').textContent = guestOf(guestId).nick;
  show('s-gfeed');
  if (push) {
    try {
      history.pushState({ gfeed: guestId, photo: photoId }, '', location.href);
    } catch (e) { /* переживём */ }
  }

  feedMore(gfeed).then(function () {
    window.scrollTo(0, 0);
    feedWatch(gfeed);
  });
}

function backToGuest() {
  show('s-guest');
  window.scrollTo(0, guestScrollY || 0);
}

function cellNode(row, mine) {
  photoRow[row.id] = row;

  var cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.id = row.id;

  var shot = document.createElement('div');
  shot.className = 'cell-shot';
  var img = document.createElement('img');
  img.src = photoUrl(row.preview_path);
  img.alt = '';
  img.loading = 'lazy';
  shot.appendChild(img);
  // с карточки открывается лента только этого гостя, начиная с этого снимка
  shot.addEventListener('click', function () { openGuestFeed(row.guest_id, row.id, true); });
  cell.appendChild(shot);

  // Удалять можно только у себя. На чужой карточке кнопки нет вовсе.
  if (mine) {
    var del = document.createElement('button');
    del.className = 'cell-del';
    del.type = 'button';
    del.textContent = 'Удалить';
    del.addEventListener('click', function () { askDelete(row.id, cell); });
    cell.appendChild(del);
  }
  return cell;
}

/* Удаление подтверждается скрытым ключом гостя: guest_id виден всем и для
   этого не годится. Программы delete_photo в базе пока нет — она появится
   вместе с загрузкой, поэтому кнопка честно говорит, что не сработала. */
function askDelete(photoId, cell) {
  if (!window.confirm('Удалить этот снимок? Вернуть его будет нельзя.')) return;
  if (!me || !me.secret) { toast('Не получилось подтвердить, что снимок ваш'); return; }

  rpc('delete_photo', { p_secret: me.secret, p_photo_id: photoId }).then(function (res) {
    if (sessionGone(res)) return;
    if (res && res.ok === true) {
      cell.remove();
      var n = parseInt(el('guest-photos').textContent, 10);
      if (!isNaN(n)) el('guest-photos').textContent = Math.max(0, n - 1);
      toast('Снимок удалён');
    } else {
      toast('Не получилось удалить снимок');
    }
  }).catch(function () {
    toast('Удаление пока не подключено');
  });
}

function backToFeed() {
  shownGuest = null;
  show('s-feed');
  // лента возвращается туда же, где её оставили, а не в начало
  window.scrollTo(0, feed.scrollY || 0);
}

/* --------------------------------------------------------------------------
   Выход из аккаунта

   Стирается только память браузера. Ничего из базы не удаляется: фотографии,
   лайки и комментарии остаются на местах, вернуться можно ником и пином.
   -------------------------------------------------------------------------- */

var askDone = null;

/* Своё окно вместо window.confirm: у встроенного кнопки называются «ОК»
   и «Отмена», а здесь на кнопке должно стоять слово «Выйти». */
function ask(text, yesLabel, onYes) {
  el('ask-text').textContent = text;
  el('ask-yes').textContent = yesLabel;
  askDone = onYes;
  el('ask').hidden = false;
}

function askClose(yes) {
  el('ask').hidden = true;
  var fn = askDone;
  askDone = null;
  if (yes && fn) fn();
}

function tapExit() {
  ask('Выйти из аккаунта? Чтобы вернуться, понадобится ваш ник и пин-код. ' +
      'Восстановить пин нельзя.', 'Выйти', doExit);
}

function doExit() {
  forgetGuest();
  saveLoginState({ fails: 0, until: 0 });
  me = null;
  shownGuest = null;
  guestShots = {};
  if (feed.poller) { clearInterval(feed.poller); feed.poller = null; }
  feedReset(feed);
  feedReset(gfeed);
  try { history.replaceState(null, '', location.href); } catch (e) { /* переживём */ }
  refreshLogin();
  startScreen();
}

/* ==========================================================================
   ЛАЙКИ, КОММЕНТАРИИ, ЖАЛОБЫ

   Всё, что зависит от «кто это», решается программой внутри базы: браузер
   присылает только скрытый ключ гостя, guest_id из браузера доверенным
   не считается. Прямую запись в likes, comments и reports у публичной роли
   на этом этапе забрали — в обход программ теперь не пройти.
   ========================================================================== */

var stats = {};    // photo_id → { likes, comments, last: [последние комментарии] }
var liked = {};    // photo_id → лайкнул ли этот гость
var photoRow = {}; // photo_id → строка снимка: по ней открывается лента гостя

function cardCount(box) {
  return (box && box[0] && typeof box[0].count === 'number') ? box[0].count : 0;
}

// Разложить счётчики, приехавшие вместе с порцией ленты
function absorbStats(rows) {
  (rows || []).forEach(function (row) {
    stats[row.id] = {
      likes: cardCount(row.likes),
      comments: cardCount(row.comments),
      last: row.last || []
    };
  });
}

/* То же самое, но для снимка, открытого мимо ленты — из карточки гостя.
   Один снимок, один запрос; в цикле по карточкам это не вызывается. */
function loadStats(ids) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return Promise.resolve();

  var q = 'photos?select=id,likes(count),comments(count),' +
          'last:comments(id,guest_id,body,created_at)' +
          '&id=in.(' + ids.join(',') + ')' +
          '&last.order=created_at.desc&last.limit=' + CONFIG.CM_PREVIEW;

  return Promise.all([
    restGet(q).then(function (r) { return r.json(); })
      .then(absorbStats)
      .catch(function () { /* сеть моргнула — покажем нули, обновится при перезагрузке */ }),
    loadMyLikes(ids)
  ]);
}

// Свои лайки на всю порцию — один вызов. Чужие так не узнать: программа
// сама находит гостя по ключу и отдаёт только его.
function loadMyLikes(ids) {
  if (!me || !me.secret || !ids.length) return Promise.resolve();
  return rpc('my_likes', { p_secret: me.secret, p_photo_ids: ids })
    .then(function (list) {
      ids.forEach(function (id) { if (!(id in liked)) liked[id] = false; });
      (list || []).forEach(function (id) { liked[id] = true; });
    })
    .catch(function () { /* сердечки останутся пустыми, нажатие всё равно работает */ });
}

// Авторы комментариев из превью: их ников в витрине могло ещё не быть
function talkAuthors(rows) {
  var out = [];
  (rows || []).forEach(function (row) {
    var s = stats[row.id];
    if (s) s.last.forEach(function (c) { out.push({ guest_id: c.guest_id }); });
  });
  return out;
}

function statOf(id) {
  if (!stats[id]) stats[id] = { likes: 0, comments: 0, last: [] };
  return stats[id];
}

/* --------------------------------------------------------------------------
   Значки. Рисуются в разметке, чтобы не тащить шрифт со значками ради трёх
   картинок; заливка сердца переключается классом.
   -------------------------------------------------------------------------- */

function icon(paths, extra) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  paths.forEach(function (d) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', (extra && extra.w) || '1.5');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
  });
  return svg;
}

var D_HEART = 'M12 20.2C7.5 16.9 4 14.2 4 10.6 4 8.1 5.9 6.2 8.3 6.2c1.5 0 2.9.7 3.7 1.9' +
              '.8-1.2 2.2-1.9 3.7-1.9 2.4 0 4.3 1.9 4.3 4.4 0 3.6-3.5 6.3-8 9.6z';
var D_TALK = 'M20 12.5c0 3.6-3.6 6.5-8 6.5-.9 0-1.8-.1-2.6-.4L5 20l1.1-3.1C4.8 15.7 4 14.2 4 12.5 4 8.9 7.6 6 12 6s8 2.9 8 6.5z';

/* --------------------------------------------------------------------------
   Строка действий под снимком
   -------------------------------------------------------------------------- */

function actNode(kind) {
  var b = document.createElement('button');
  b.className = 'act act-' + kind;
  b.type = 'button';
  b.appendChild(icon([kind === 'like' ? D_HEART : D_TALK]));
  var n = document.createElement('span');
  n.className = 'act-n';
  b.appendChild(n);
  return b;
}

function actsNode(row) {
  var wrap = document.createElement('div');
  wrap.className = 'acts';
  wrap.dataset.id = row.id;

  var like = actNode('like');
  like.setAttribute('aria-label', 'Нравится');
  like.addEventListener('click', function () { tapLike(row.id); });

  var talk = actNode('talk');
  talk.setAttribute('aria-label', 'Комментарии');
  talk.addEventListener('click', function () { openSheet(row.id, true); });

  // Жалоба — обычная текстовая кнопка справа, а не значок: в значок
  // пальцем не попасть, а слово читается без догадок.
  var report = document.createElement('button');
  report.className = 'act-report';
  report.type = 'button';
  report.textContent = 'Пожаловаться';
  report.addEventListener('click', function () { tapReport(row.id); });

  wrap.appendChild(like);
  wrap.appendChild(talk);
  wrap.appendChild(report);
  return wrap;
}

/* Два последних комментария прямо в ленте и строка «показать все N» */
function talkNode(row) {
  var box = document.createElement('div');
  box.className = 'talk';
  box.dataset.id = row.id;
  return box;
}

function cmWord(n) {
  var t = n % 10, h = n % 100;
  if (t === 1 && h !== 11) return 'комментарий';
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'комментария';
  return 'комментариев';
}

function nickOf(guestId) {
  return guestOf(guestId).nick;
}

function fillTalk(box, id) {
  var s = statOf(id);
  box.innerHTML = '';
  if (!s.comments) { box.hidden = true; return; }
  box.hidden = false;

  if (s.comments > s.last.length) {
    var more = document.createElement('button');
    more.className = 'talk-all';
    more.type = 'button';
    more.textContent = 'Показать все ' + s.comments + ' ' + cmWord(s.comments);
    more.addEventListener('click', function () { openSheet(id, true); });
    box.appendChild(more);
  }

  // в базе они лежат от свежих к старым, а читаются сверху вниз
  s.last.slice().reverse().forEach(function (c) {
    var p = document.createElement('p');
    p.className = 'talk-line';
    var b = document.createElement('b');
    b.textContent = nickOf(c.guest_id);
    p.appendChild(b);
    p.appendChild(document.createTextNode(' ' + c.body));
    box.appendChild(p);
  });
}

/* Один снимок может стоять сразу на двух экранах — в ленте и на странице фото.
   Перерисовываем всюду, где он встретился, чтобы числа не разъезжались. */
function paintIn(root, id) {
  var s = statOf(id);
  all('.acts[data-id="' + id + '"]', root).forEach(function (wrap) {
    var like = wrap.querySelector('.act-like');
    var talk = wrap.querySelector('.act-talk');
    if (like) {
      like.classList.toggle('is-on', !!liked[id]);
      like.setAttribute('aria-pressed', liked[id] ? 'true' : 'false');
      like.querySelector('.act-n').textContent = s.likes;
    }
    if (talk) talk.querySelector('.act-n').textContent = s.comments;
  });
  all('.talk[data-id="' + id + '"]', root).forEach(function (box) { fillTalk(box, id); });
}

function paintPhoto(id) { paintIn(document, id); }

/* --------------------------------------------------------------------------
   Лайк. Число меняется сразу, запрос уходит следом; не прошёл — вернём назад.
   -------------------------------------------------------------------------- */

function tapLike(id) {
  if (siteState() === 'closed') { applyState(); return; }
  if (!me || !me.secret) { toast('Не получилось подтвердить, кто вы'); return; }

  var s = statOf(id);
  var wasLiked = !!liked[id], wasN = s.likes;

  liked[id] = !wasLiked;
  s.likes = Math.max(0, wasN + (wasLiked ? -1 : 1));
  paintPhoto(id);
  if (!wasLiked) bumpHeart(id);

  rpc('toggle_like', { p_secret: me.secret, p_photo_id: id }).then(function (res) {
    if (sessionGone(res)) return;
    if (!res || res.ok !== true) throw new Error((res && res.error) || 'отказ');
    liked[id] = !!res.liked;
    s.likes = res.likes;
    paintPhoto(id);
  }).catch(function () {
    liked[id] = wasLiked;
    s.likes = wasN;
    paintPhoto(id);
    toast('Лайк не сохранился');
  });
}

/* Двойной тап только ставит лайк и никогда его не снимает: снять можно
   сердцем в строке действий. Так в инстаграме, и так безопаснее — случайный
   второй двойной тап не отнимет у автора лайк. Анимацию показываем в любом
   случае, даже если фото уже нравится: палец должен получить отклик. */
function likeByTap(id) {
  popHeart(id);
  if (liked[id]) return;
  tapLike(id);
}

// Крупное сердце по центру снимка
function popHeart(id) {
  all('.card[data-id="' + id + '"] .pop').forEach(function (pop) {
    pop.classList.remove('is-pop');
    void pop.offsetWidth;              // перезапуск анимации при частых тапах
    pop.classList.add('is-pop');
  });
}

// Короткий подскок сердца в строке действий
function bumpHeart(id) {
  all('.acts[data-id="' + id + '"] .act-like').forEach(function (b) {
    b.classList.remove('is-bump');
    void b.offsetWidth;
    b.classList.add('is-bump');
  });
}

/* --------------------------------------------------------------------------
   Жалоба. Одна от гостя на снимок; третья прячет снимок, но не удаляет его —
   он ждёт разбора в панели владельца. Автору ничего не показываем.
   -------------------------------------------------------------------------- */

function tapReport(id) {
  if (siteState() === 'closed') { applyState(); return; }
  if (!me || !me.secret) { toast('Не получилось подтвердить, кто вы'); return; }
  if (!window.confirm('Пожаловаться на это фото?')) return;

  rpc('add_report', { p_secret: me.secret, p_photo_id: id }).then(function (res) {
    if (sessionGone(res)) return;
    if (!res || res.ok !== true) { toast('Жалоба не отправилась'); return; }
    toast(res.already ? 'Вы уже жаловались на это фото' : 'Жалоба отправлена');
    if (res.hidden) dropPhoto(id);
  }).catch(function () {
    toast('Жалоба не отправилась');
  });
}

/* Гостя больше нет: его забанили, пока страница была открыта.
   Все программы базы отвечают на это одинаково — 'no_guest', потому что
   guest_by_key не находит забаненного по ключу.

   Раньше страница разбирала такой ответ как обычный сбой сети и предлагала
   «попробуйте ещё раз» — гость жал снова и снова, и выходило, будто сломались
   комментарии. Показываем то же, что показала бы перезагрузка: «Вход закрыт».
   Возвращает true, если разговор окончен и звавшему делать больше нечего. */
function sessionGone(res) {
  if (!res || res.error !== 'no_guest') return false;
  show('s-blocked');
  return true;
}

// Снимок скрыт — убираем его с глаз, не перезагружая ленту
function dropPhoto(id) {
  if (sheet.photoId === id) sheetDismiss();
  all('#feed .card[data-id="' + id + '"]').forEach(function (card) {
    card.remove();
    if (feed.offset > 0) feed.offset -= 1;
  });
  all('#gfeed .card[data-id="' + id + '"]').forEach(function (card) {
    card.remove();
    if (gfeed.offset > 0) gfeed.offset -= 1;
  });
  all('.cell[data-id="' + id + '"]').forEach(function (cell) {
    cell.remove();
    var n = parseInt(el('guest-photos').textContent, 10);
    if (!isNaN(n)) el('guest-photos').textContent = Math.max(0, n - 1);
  });
}

/* ==========================================================================
   ШТОРКА КОММЕНТАРИЕВ

   Отдельного экрана комментариев больше нет: они выезжают снизу поверх ленты,
   а лента под ними остаётся на месте. Всё движение — только translateY:
   ни top, ни height, ни margin здесь не трогаются, иначе браузер пересчитывает
   разметку на каждый кадр и на слабых телефонах шторка дёргается.
   ========================================================================== */

var sheet = {
  photoId: null,
  open: false,
  pushed: false,     // положили ли мы запись в историю переходов
  backPending: false,// сами попросили браузер вернуться и ждём его ответа
  h: 0,              // высота шторки в точках, считается при открытии
  y: 0,              // на сколько шторка уехала вниз прямо сейчас
  drag: null,        // состояние перетаскивания
  frame: 0,          // номер запрошенного кадра
  lockY: 0           // где стояла лента, когда шторку открыли
};

function sheetEl() { return el('sheet-card'); }

/* Пока шторка открыта, лента под ней стоит на месте: без этого палец
   у края шторки прокручивает не список, а ленту, а на айфоне страница
   ещё и оттягивается вниз. */
/* Запирается лента один раз. Если шторку закрыли и тут же открыли снова,
   старое смещение ещё не вернули — и запомнить сейчас можно только ноль,
   после чего лента при закрытии прыгнет в начало. */
function lockPage() {
  if (document.body.classList.contains('is-locked')) return;
  sheet.lockY = window.scrollY;
  document.body.style.top = (-sheet.lockY) + 'px';
  document.body.classList.add('is-locked');
}

function unlockPage() {
  document.body.classList.remove('is-locked');
  document.body.style.top = '';
  window.scrollTo(0, sheet.lockY || 0);
}

function openSheet(photoId, push) {
  if (!photoId) return;
  sheet.photoId = photoId;
  sheet.open = true;

  el('cm-list').innerHTML = '';
  el('cm-none').hidden = true;
  el('cm-none').textContent = 'Пока ни одного комментария';
  el('say-input').value = '';
  setErr('err-say', '');
  sayLeft();

  var wrap = el('sheet');
  wrap.hidden = false;
  lockPage();

  /* Высота нужна для порога закрытия; читаем после того, как шторка в разметке.
     Открытие ведёт CSS: ставим шторку вниз без плавности, заставляем браузер
     пересчитать разметку — и отпускаем. Кадр отрисовки для этого не нужен,
     а значит открытие не зависит от того, рисует ли браузер страницу прямо
     сейчас. Дальше всем распоряжается класс is-open. */
  var card = sheetEl();
  sheet.h = card.getBoundingClientRect().height || Math.round(window.innerHeight * 0.85);
  card.style.transition = 'none';
  card.style.transform = 'translateY(' + sheet.h + 'px)';
  void card.offsetWidth;
  card.style.transition = '';
  card.style.transform = '';
  sheet.y = 0;
  wrap.classList.add('is-open');

  if (push) {
    sheet.pushed = true;
    try { history.pushState({ sheet: photoId }, '', location.href); } catch (e) { sheet.pushed = false; }
  }

  // из карточки гостя снимок мог открыться мимо ленты — тогда про лайки
  // мы ещё ничего не знаем и один раз дочитываем
  if (!(photoId in liked)) loadStats([photoId]).then(function () { paintPhoto(photoId); });
  loadComments(photoId);
}

/* Пользователь закрывает шторку сам: анимация идёт сразу, история догоняет.
   Браузер отвечает на history.back() не тут же, а следующим событием, и за
   это время шторку успевают открыть заново — например, ткнув в соседнее фото.
   Поэтому свой возврат помечаем: пришедшее событие закрывать уже нечего. */
function sheetDismiss() {
  if (!sheet.open) return;
  sheetHide();
  if (sheet.pushed) {
    sheet.pushed = false;
    sheet.backPending = true;
    history.back();
  }
}

function sheetHide() {
  if (!sheet.open) return;
  sheet.open = false;
  sheet.photoId = null;

  var wrap = el('sheet');
  wrap.classList.remove('is-open', 'is-dragging');
  // убираем свой transform и отдаём закрытие тому же классу: без is-open
  // шторка уезжает на свою высоту вниз, и делает это плавно
  if (sheet.frame) { cancelAnimationFrame(sheet.frame); sheet.frame = 0; }
  sheetEl().style.transform = '';
  sheet.y = sheet.h;

  var input = el('say-input');
  if (input) input.blur();

  setTimeout(function () {
    if (sheet.open) return;            // успели открыть заново
    wrap.hidden = true;
    unlockPage();
  }, CONFIG.SHEET_MS);
}

/* Единственное место, где шторка двигается пальцем. Обращения идут через кадр
   отрисовки: за один кадр transform ставится один раз, сколько бы событий
   перемещения ни пришло. */
function sheetMove(y) {
  sheet.y = y;
  if (sheet.frame) return;
  sheet.frame = requestAnimationFrame(function () {
    sheet.frame = 0;
    sheetEl().style.transform = 'translateY(' + sheet.y + 'px)';
  });
}

/* --------------------------------------------------------------------------
   Перетаскивание. Тянуть можно за ручку, за шапку и за список — но список
   отдаёт жест только пока прокручен в самый верх, иначе палец листает его.
   -------------------------------------------------------------------------- */

function wireSheetDrag() {
  var wrap = el('sheet');
  var card = sheetEl();
  var list = el('sheet-list');

  function startsHere(target) {
    return el('sheet-grab').contains(target) || el('sheet-head').contains(target) ||
           list.contains(target);
  }

  card.addEventListener('pointerdown', function (e) {
    if (!sheet.open || e.button) return;
    if (!startsHere(e.target)) return;
    // с поля ввода и кнопок жест не начинаем: там свои дела
    if (e.target.closest && e.target.closest('.say')) return;

    sheet.drag = {
      id: e.pointerId,
      y0: e.clientY,
      fromList: list.contains(e.target),
      atTop: list.scrollTop <= 0,
      active: false,
      marks: [{ y: e.clientY, t: performance.now() }]
    };
  }, { passive: true });

  /* Перемещение и отпускание слушаем на окне, а не на самой шторке.
     Шторка уезжает вниз вместе с пальцем и выходит у него из-под низа,
     после чего события до неё просто не доходят и жест обрывается на первых
     же точках. Окно получает их всегда, чем бы шторка ни двигалась. */
  window.addEventListener('pointermove', function (e) {
    var d = sheet.drag;
    if (!d || e.pointerId !== d.id) return;

    var dy = e.clientY - d.y0;

    if (!d.active) {
      // из списка жест забираем, только если он и правда стоит наверху
      if (d.fromList && !(d.atTop && list.scrollTop <= 0)) { sheet.drag = null; return; }
      if (dy <= 2) return;                      // вверх шторка не тянется
      /* Точку отсчёта не сдвигаем: смещение шторки должно совпадать
         со смещением пальца ровно, а не отставать на порог распознавания. */
      d.active = true;
      wrap.classList.add('is-dragging');        // плавность снимаем целиком
    }

    if (dy < 0) dy = 0;                         // выше открытого положения не пускаем
    d.marks.push({ y: e.clientY, t: performance.now() });
    if (d.marks.length > 6) d.marks.shift();
    sheetMove(dy);
  }, { passive: true });

  /* Жест мог не закончиться, а оборваться: браузер забрал его себе, пришёл
     звонок, палец ушёл за край. Это не решение гостя закрыть шторку, поэтому
     ни скорость, ни путь тут не считаются — шторка просто возвращается. */
  function cancel(e) {
    var d = sheet.drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    sheet.drag = null;
    if (!d.active) return;
    wrap.classList.remove('is-dragging');
    sheetMove(0);
  }

  function finish(e) {
    var d = sheet.drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    sheet.drag = null;
    if (!d.active) return;

    wrap.classList.remove('is-dragging');

    /* Скорость последних миллисекунд движения. Быстрый рывок вниз закрывает
       шторку, даже если она уехала совсем чуть-чуть; медленное движение
       решается по пройденному пути. */
    var last = d.marks[d.marks.length - 1];
    var first = d.marks[0];
    for (var i = d.marks.length - 1; i >= 0; i--) {
      if (last.t - d.marks[i].t > 120) break;
      first = d.marks[i];
    }
    var dt = Math.max(1, last.t - first.t);
    var v = (last.y - first.y) / dt;

    /* Палец мог быстро увести шторку, замереть и только потом отпустить —
       это уже не рывок, а осознанная остановка. Свежих отсчётов нет, значит
       и скорости нет: решает пройденный путь. */
    if (performance.now() - last.t > 120) v = 0;

    var far = sheet.y > (sheet.h || window.innerHeight) * CONFIG.SHEET_CLOSE_PART;
    if (v > CONFIG.SHEET_FLING || far) sheetDismiss();
    else sheetMove(0);
  }

  window.addEventListener('pointerup', finish, { passive: true });
  window.addEventListener('pointercancel', cancel, { passive: true });

  /* Мышью медленное движение с зажатой кнопкой браузер принимает за
     перетаскивание содержимого: начинается своё, встроенное, а наш жест
     обрывается на первых же точках. Из шторки перетаскивать нечего —
     запрещаем целиком. */
  card.addEventListener('dragstart', function (e) { e.preventDefault(); });

  /* Единственное место, где прокрутка отменяется руками, — поэтому только
     здесь слушатель не passive. Пока шторку тянут, список под пальцем
     листаться не должен. */
  window.addEventListener('touchmove', function (e) {
    if (sheet.drag && sheet.drag.active && e.cancelable) e.preventDefault();
  }, { passive: false });

  el('sheet-back').addEventListener('click', function () { sheetDismiss(); });
}

/* Клавиатура на айфоне не двигает разметку, а лишь ужимает видимую часть
   экрана. Без этого поле ввода остаётся под клавиатурой — обычная поломка
   шторок. Следим за видимой частью и подставляем шторке отступ снизу. */
function wireKeyboard() {
  var vv = window.visualViewport;
  if (!vv) return;

  function fit() {
    if (!sheet.open) { sheetEl().style.bottom = ''; sheetEl().style.maxHeight = ''; return; }
    var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sheetEl().style.bottom = kb + 'px';
    sheetEl().style.maxHeight = Math.round(vv.height - 8) + 'px';
  }

  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}

/* --------------------------------------------------------------------------
   Список комментариев
   -------------------------------------------------------------------------- */

// Весь список комментариев к снимку — одним запросом
function loadComments(id) {
  return restGet('comments?select=id,guest_id,body,created_at&photo_id=eq.' +
                 encodeURIComponent(id) + '&order=created_at.asc')
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      if (sheet.photoId !== id) return;
      rows = rows || [];
      var s = statOf(id);
      s.comments = rows.length;
      s.last = rows.slice(-CONFIG.CM_PREVIEW).reverse();
      return ensureGuests(rows).then(function () {
        if (sheet.photoId !== id) return;
        drawComments(id, rows);
        paintPhoto(id);
      });
    })
    .catch(function () {
      if (sheet.photoId === id) {
        el('cm-none').textContent = 'Комментарии не загрузились';
        el('cm-none').hidden = false;
      }
    });
}

function drawComments(id, rows) {
  var box = el('cm-list');
  box.innerHTML = '';
  rows.forEach(function (c) { box.appendChild(commentNode(id, c)); });
  el('cm-none').hidden = rows.length > 0;
}

function commentNode(photoId, c) {
  var g = guestOf(c.guest_id);

  var wrap = document.createElement('div');
  wrap.className = 'cm';
  wrap.dataset.id = c.id;

  /* Аватарка и ник ведут на карточку автора. Шторка при этом закрывается:
     иначе карточка гостя окажется под ней. */
  function toGuest() { sheetToGuest(c.guest_id); }

  var face = document.createElement('button');
  face.className = 'cm-face';
  face.type = 'button';
  face.setAttribute('aria-label', 'Карточка гостя ' + g.nick);
  var faceImg = document.createElement('img');
  faceImg.src = avatarUrl(g.avatar_kind, g.avatar_value);   // нет своей — встанет заглушка
  faceImg.alt = '';
  face.appendChild(faceImg);
  face.addEventListener('click', toGuest);

  var main = document.createElement('div');
  main.className = 'cm-main';

  var body = document.createElement('p');
  body.className = 'cm-body';
  var nick = document.createElement('button');
  nick.className = 'cm-nick';
  nick.type = 'button';
  nick.textContent = g.nick;
  nick.addEventListener('click', toGuest);
  body.appendChild(nick);
  body.appendChild(document.createTextNode(' ' + c.body));

  var foot = document.createElement('p');
  foot.className = 'cm-foot';
  var time = document.createElement('time');
  time.dateTime = c.created_at;
  time.textContent = hhmm(c.created_at);
  foot.appendChild(time);

  // Удалять можно только своё. У чужого комментария кнопки нет вовсе,
  // а если её подставить руками — база всё равно откажет.
  if (me && me.id === c.guest_id) {
    var del = document.createElement('button');
    del.className = 'cm-del';
    del.type = 'button';
    del.textContent = 'Удалить';
    del.addEventListener('click', function () { askDeleteComment(photoId, c.id, wrap); });
    foot.appendChild(del);
  }

  main.appendChild(body);
  main.appendChild(foot);
  wrap.appendChild(face);
  wrap.appendChild(main);
  return wrap;
}

/* Со шторки — на карточку гостя. Запись шторки в истории переходов заменяем
   записью карточки, а не добавляем поверх: иначе «назад» с карточки вернуло бы
   шторку, которой на экране уже нет. */
function sheetToGuest(guestId) {
  var pushed = sheet.pushed;
  sheet.pushed = false;
  sheetHide();
  if (pushed) {
    try { history.replaceState({ guest: guestId }, '', location.href); } catch (e) { /* переживём */ }
    openGuest(guestId, false);
  } else {
    openGuest(guestId, true);
  }
}

function askDeleteComment(photoId, commentId, node) {
  if (!window.confirm('Удалить свой комментарий?')) return;
  if (!me || !me.secret) { toast('Не получилось подтвердить, что комментарий ваш'); return; }

  rpc('delete_comment', { p_secret: me.secret, p_comment_id: commentId }).then(function (res) {
    if (sessionGone(res)) return;
    if (!res || res.ok !== true) { toast('Не получилось удалить комментарий'); return; }
    node.remove();
    var s = statOf(photoId);
    s.comments = Math.max(0, s.comments - 1);
    s.last = s.last.filter(function (c) { return c.id !== commentId; });
    el('cm-none').hidden = s.comments > 0;
    paintPhoto(photoId);
    toast('Комментарий удалён');
  }).catch(function () {
    toast('Не получилось удалить комментарий');
  });
}

function sayLeft() {
  var left = CONFIG.CM_MAX - el('say-input').value.length;
  el('say-left').textContent = 'Осталось знаков: ' + left;
}

function saySend() {
  if (siteState() === 'closed') { applyState(); return; }
  setErr('err-say', '');

  var id = sheet.photoId;
  if (!id) return;
  var body = el('say-input').value;

  /* Длина, пустота, грубость и ссылки проверяются здесь — до отправки.
     Длину и пустоту база проверяет ещё раз у себя: браузерную проверку
     обходят, программу внутри базы — нет. */
  var bad = commentError(body);
  if (bad) { setErr('err-say', bad); return; }

  if (!me || !me.secret) { setErr('err-say', 'Не получилось подтвердить, кто вы'); return; }

  var btn = el('say-go');
  busy(btn, true, '…');

  rpc('add_comment', { p_secret: me.secret, p_photo_id: id, p_body: body.trim() })
    .then(function (res) {
      busy(btn, false);
      if (sessionGone(res)) return;
      if (!res || res.ok !== true) {
        var code = res && res.error;
        setErr('err-say',
          code === 'too_long' ? 'Слишком длинно, не больше ' + CONFIG.CM_MAX + ' знаков' :
          code === 'empty' ? 'Напишите что-нибудь, пустой комментарий не отправляется' :
          'Комментарий не отправился. Попробуйте ещё раз');
        return;
      }
      var c = res.comment;
      if (c && c.guest_id && c.nick && !guestMap[c.guest_id]) {
        guestMap[c.guest_id] = { id: c.guest_id, nick: c.nick, avatar_kind: 'preset', avatar_value: '1' };
      }
      el('say-input').value = '';
      sayLeft();
      if (sheet.photoId === id && c) {
        var box = el('cm-list');
        box.appendChild(commentNode(id, c));
        el('cm-none').hidden = true;
        var s = statOf(id);
        s.comments += 1;
        s.last = [c].concat(s.last).slice(0, CONFIG.CM_PREVIEW);
        paintPhoto(id);
        // свой свежий комментарий должен быть виден, а не остаться за краем
        el('sheet-list').scrollTop = el('sheet-list').scrollHeight;
      }
    })
    .catch(function () {
      busy(btn, false);
      setErr('err-say', 'Комментарий не отправился. Попробуйте ещё раз');
    });
}

/* ==========================================================================
   ЗАГРУЗКА ФОТО
   ========================================================================== */

/* Имя файла — единственное место, откуда лента узнаёт пропорции снимка:
   полей под ширину и высоту в таблице photos нет, а место под фото надо занять
   до того, как оно приедет. Правило читает SIZE_RE выше по файлу, поэтому имя
   обязано кончаться на -ШИРИНАxВЫСОТА.jpg, и числа — настоящие пиксели уже
   сжатого превью, а не исходника. Ник в имя не кладём: он бывает кириллицей,
   а в пути хранилища нужен чистый ASCII без пробелов. */
function shotName(w, h) {
  var who = String((me && me.id) || 'guest').replace(/[^0-9a-z]/gi, '').slice(0, 8) || 'guest';
  var when = Date.now().toString(36);
  var tail = (Math.random().toString(36) + '000000').slice(2, 8);
  return CONFIG.UP_DIR + '/' + who + '-' + when + '-' + tail + '-' + w + 'x' + h + '.jpg';
}

function canvasJpeg(c, q) {
  return new Promise(function (resolve, reject) {
    c.toBlob(function (b) { b ? resolve(b) : reject(new Error('не пересохранился')); }, 'image/jpeg', q);
  });
}

/* Качество подбираем ступенями и берём первое, которое уложилось в 150 КБ.
   Если даже самая грубая ступень дала больше 250 КБ — снимок мелкоузорчатый,
   такой сжимается плохо, — уменьшаем длинную сторону и пересохраняем ещё раз.
   Пропорции не трогаем ни на одном шаге. */
var UP_STEPS = [0.72, 0.62, 0.52, 0.42];

function shrinkPhoto(file) {
  return normalizedCanvas(file, CONFIG.UP_SIDE).then(function (c) {
    return ladder(c, 0).then(function (r) {
      if (r.blob.size <= CONFIG.UP_HARD_BYTES) return r;

      var k = Math.min(1, CONFIG.UP_SIDE_TIGHT / Math.max(c.width, c.height));
      var c2 = document.createElement('canvas');
      c2.width = Math.max(1, Math.round(c.width * k));
      c2.height = Math.max(1, Math.round(c.height * k));
      var x = c2.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(c, 0, 0, c2.width, c2.height);
      return canvasJpeg(c2, 0.5).then(function (b) {
        return { blob: b, w: c2.width, h: c2.height };
      });
    });
  });

  function ladder(c, i) {
    return canvasJpeg(c, UP_STEPS[i]).then(function (b) {
      if (b.size <= CONFIG.UP_TARGET_BYTES || i === UP_STEPS.length - 1) {
        return { blob: b, w: c.width, h: c.height };
      }
      return ladder(c, i + 1);
    });
  }
}

/* --------------------------------------------------------------------------
   Отправка одного файла
   -------------------------------------------------------------------------- */

function putPhoto(name, blob) {
  return fetchTimed(CONFIG.SUPABASE_URL + '/storage/v1/object/' + CONFIG.PHOTO_BUCKET + '/' + name, {
    method: 'POST',
    headers: {
      apikey: CONFIG.SUPABASE_KEY,
      Authorization: 'Bearer ' + CONFIG.SUPABASE_KEY,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'false'
    },
    body: blob
  }, CONFIG.UP_TIMEOUT_MS).then(function (r) {
    if (r.ok) return name;
    /* Файл с таким именем уже лежит — значит прошлая попытка успела долить его
       и оборвалась уже на ответе. Слать второй раз нечего. Хранилище отвечает
       на это кодом 400, а настоящий 409 прячет в теле ответа. */
    return r.text().then(function (t) {
      if (/KeyAlreadyExists|already exists/i.test(t || '')) return name;
      throw new Error('хранилище ответило ' + r.status);
    });
  });
}

// Поле yadisk_path не заполняем вовсе — оно останется пустым до этапа 7
function addPhotoRow(name) {
  return fetchTimed(CONFIG.SUPABASE_URL + '/rest/v1/photos', {
    method: 'POST',
    headers: dbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ guest_id: me.id, preview_path: name })
  }, CONFIG.UP_TIMEOUT_MS).then(function (r) {
    if (!r.ok) throw new Error('база ответила ' + r.status);
    return r.json();
  }).then(function (rows) { return (rows && rows[0]) || null; });
}

function findRow(name) {
  return restGet('photos?select=id,guest_id,preview_path,created_at&preview_path=eq.' +
                 encodeURIComponent(name) + '&limit=1')
    .then(function (r) { return r.json(); })
    .then(function (rows) { return (rows && rows[0]) || null; });
}

function waitMs(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// Пауза между попытками нарастает: сеть в зале проседает волнами
var UP_PAUSE = [1200, 3000, 7000];

function tryTimes(fn, times) {
  var n = 0;
  function go() {
    return fn().catch(function (e) {
      n++;
      if (n >= times) throw e;
      return waitMs(UP_PAUSE[Math.min(n - 1, UP_PAUSE.length - 1)]).then(go);
    });
  }
  return go();
}

function putAndRow(it) {
  var put = it.stored ? Promise.resolve() : putPhoto(it.name, it.blob).then(function () { it.stored = true; });
  return put.then(function () {
    // Повтор после обрыва: запись могла и долететь, просто ответ не вернулся.
    // Не проверив, поставим один снимок в ленту дважды.
    return it.rowTried ? findRow(it.name) : null;
  }).then(function (found) {
    if (found) return found;
    it.rowTried = true;
    return addPhotoRow(it.name);
  }).then(function (row) {
    if (row) feedPrepend(row);
    return row;
  });
}

/* Перед каждым файлом заново читаем настройки: окно приёма могло закрыться,
   а рубильник — выключиться уже после того, как гость открыл страницу. */
function sendItem(it) {
  return readSettings().then(function () {
    applyState();
    var stop = uploadStop();
    if (stop) throw { gate: (stop === 'closed' ? 'Сайт закрыт' : stop) };

    if (it.blob) return null;
    return shrinkPhoto(it.file).then(function (r) {
      it.blob = r.blob;
      it.name = shotName(r.w, r.h);
      // мелкое превью подменяем сжатым: оно уже стоит правильной стороной вверх
      var u = URL.createObjectURL(r.blob);
      if (it.url) URL.revokeObjectURL(it.url);
      it.url = u;
      it.img.src = u;
    }, function () {
      throw { bad: true };               // браузер не открыл файл, повторять нечего
    });
  }).then(function () {
    return tryTimes(function () { return putAndRow(it); }, CONFIG.UP_TRIES);
  });
}

/* --------------------------------------------------------------------------
   Очередь: файлы уходят по одному
   -------------------------------------------------------------------------- */

var queue = { items: [], running: false };

function upCount(state) {
  return queue.items.filter(function (it) { return it.state === state; }).length;
}

function upSettled() {
  return queue.items.filter(function (it) {
    return it.state === 'done' || it.state === 'fail' || it.state === 'bad';
  }).length;
}

function upProgress() {
  var total = queue.items.length;
  if (!total) return;
  var settled = upSettled();
  el('up-line').textContent = 'Отправляется ' + Math.min(settled + 1, total) + ' из ' + total;
  el('up-fill').style.width = Math.round(settled / total * 100) + '%';
}

function upReset() {
  queue.items.forEach(function (it) { if (it.url) URL.revokeObjectURL(it.url); });
  queue.items = [];
  queue.running = false;
  el('up-thumbs').innerHTML = '';
  el('up-run').hidden = true;
  el('up-done').hidden = true;
  el('up-retry').hidden = true;
  el('up-warn').hidden = false;
  el('up-fill').style.width = '0';
  el('up-pick').disabled = false;
  setErr('err-upload', '');
}

function upNote(text) {
  setErr('err-upload', text);
}

function openUpload() {
  var stop = uploadStop();
  if (stop === 'closed') { applyState(); return; }
  if (stop) { toast(stop); return; }

  upReset();
  show('s-upload');
  try { history.pushState({ up: 1 }, '', location.href); } catch (e) { /* переживём */ }

  /* Страница могла провисеть открытой полдня. Пока гость смотрит на пунктирную
     рамку, перечитываем настройки — незачем давать выбрать десять снимков,
     если приём уже закрыт. Решающая проверка всё равно стоит перед отправкой. */
  readSettings().then(function () {
    if (!el('s-upload').classList.contains('is-on')) return;
    applyState();
    var again = uploadStop();
    if (again === 'closed') { applyState(); return; }
    if (again) {
      el('up-pick').disabled = true;
      upNote(again);
    }
  });
}

function upPick(list) {
  var files = Array.prototype.slice.call(list || []);
  if (!files.length) return;

  upReset();
  var notes = [];

  if (files.length > CONFIG.UP_MAX_FILES) {
    notes.push('Выбрано ' + files.length + ' фото, а за раз можно до ' + CONFIG.UP_MAX_FILES +
               '. Отправим первые ' + CONFIG.UP_MAX_FILES + ', остальные пришлите следующей пачкой.');
    files = files.slice(0, CONFIG.UP_MAX_FILES);
  }

  var good = [];
  files.forEach(function (f) {
    var kind = String(f.type || '');
    // У части айфонов тип пустой — такой файл не отбрасываем, пусть решает холст
    if (kind && !/^image\//i.test(kind)) { notes.push('Это не фотография: ' + (f.name || 'файл') + '.'); return; }
    if (f.size > CONFIG.UP_MAX_BYTES) { notes.push('Файл слишком большой: ' + (f.name || 'файл') + '.'); return; }
    good.push(f);
  });

  if (notes.length) upNote(notes.join(' '));
  if (!good.length) return;

  var row = el('up-thumbs');
  good.forEach(function (f) {
    var it = { file: f, state: 'wait', stored: false, rowTried: false, url: null };
    it.box = document.createElement('span');
    it.box.className = 'up-thumb';
    it.img = document.createElement('img');
    it.img.alt = '';
    try { it.url = URL.createObjectURL(f); it.img.src = it.url; } catch (e) { /* покажем серым */ }
    it.box.appendChild(it.img);
    row.appendChild(it.box);
    queue.items.push(it);
  });

  el('up-run').hidden = false;
  upProgress();
  runQueue();
}

function runQueue() {
  if (queue.running) return;
  queue.running = true;
  el('up-done').hidden = true;
  el('up-retry').hidden = true;
  el('up-run').hidden = false;
  el('up-warn').hidden = false;
  el('up-pick').disabled = true;
  step();

  function next() {
    for (var i = 0; i < queue.items.length; i++) {
      if (queue.items[i].state === 'wait') return queue.items[i];
    }
    return null;
  }

  function stop(reason) {
    queue.running = false;
    el('up-pick').disabled = false;
    el('up-warn').hidden = true;              // отправка встала, предупреждать не о чем
    upNote(reason);
    el('up-done').hidden = false;
    el('up-retry').hidden = false;
    el('up-result').textContent = 'Отправка остановлена: ' + reason;
    toast(reason);
  }

  function step() {
    var it = next();
    if (!it) { queue.running = false; el('up-pick').disabled = false; upFinish(); return; }

    it.state = 'work';
    upProgress();

    sendItem(it).then(function () {
      it.state = 'done';
      it.box.classList.add('is-done');
      upProgress();
      step();
    }, function (e) {
      if (e && e.gate) { it.state = 'wait'; stop(e.gate); return; }
      // очередь не обрываем: один упавший снимок не должен уносить остальные
      it.state = (e && e.bad) ? 'bad' : 'fail';
      it.box.classList.add('is-bad');
      if (e && e.bad) upNote('Не удалось прочитать фото, попробуйте другое.');
      upProgress();
      step();
    });
  }
}

function upFinish() {
  var total = queue.items.length;
  var okN = upCount('done'), failN = upCount('fail'), badN = upCount('bad');

  el('up-line').textContent = 'Отправлено ' + okN + ' из ' + total;
  el('up-fill').style.width = '100%';
  el('up-warn').hidden = true;                // очередь кончилась, страницу можно закрывать

  var lines = [];
  if (okN) lines.push('Готово: ' + okN + ' фото в ленте.');
  if (failN) lines.push(failN + ' фото не ' + (failN === 1 ? 'отправилось' : 'отправились') + ', попробуйте ещё раз.');
  if (badN) lines.push('Не удалось прочитать ' + badN + ' фото, попробуйте другие.');

  el('up-result').textContent = lines.join(' ');
  el('up-retry').hidden = !failN;
  el('up-done').hidden = false;
}

// Повтор берёт только несработавшие: успешные заново не шлём
function upRetry() {
  queue.items.forEach(function (it) {
    if (it.state === 'fail') { it.state = 'wait'; it.box.classList.remove('is-bad'); }
  });
  setErr('err-upload', '');
  if (!queue.items.some(function (it) { return it.state === 'wait'; })) return;
  runQueue();
}

/* --------------------------------------------------------------------------
   Сеанс: помним гостя между заходами
   -------------------------------------------------------------------------- */

function restoreSession() {
  var saved = loadGuest();
  if (!saved || !saved.secret) { startScreen(); return; }

  rpc('guest_by_secret', { p_secret: saved.secret }).then(function (res) {
    if (!res || res.ok !== true) {
      if (res && res.error === 'banned') { show('s-blocked'); return; }
      forgetGuest();
      startScreen();
      return;
    }
    return isBanned(res.id).then(function (banned) {
      if (banned) { show('s-blocked'); return; }
      res.secret = saved.secret;
      saveGuest(res);
      enterFeed(res);
    });
  }).catch(function () {
    // сеть подвела — гостя не забываем, пускаем внутрь по памяти браузера
    enterFeed(saved);
  });
}

/* --------------------------------------------------------------------------
   Сборка
   -------------------------------------------------------------------------- */

function init() {
  all('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { clearErrs(); show(b.dataset.goto); });
  });

  el('go-reg').addEventListener('click', function () { clearErrs(); show('s-reg'); el('reg-nick').focus(); });
  el('go-login').addEventListener('click', function () { clearErrs(); refreshLogin(); show('s-login'); });

  wirePin('reg-pin');
  wirePin('log-pin');

  // на клавиатуре с «Готово» удобнее закончить ввод, не целясь в кнопку
  ['reg-nick', 'reg-word'].forEach(function (id) {
    el(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); regNext(); } });
  });
  el('log-nick').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); loginGo(); } });

  el('reg-next').addEventListener('click', regNext);
  el('reg-finish').addEventListener('click', regFinish);

  all('#avatar-grid .ava').forEach(function (b) {
    b.addEventListener('click', function () { pickAvatar(b); });
  });
  pickAvatar(document.querySelector('#avatar-grid .ava'));

  el('pick-photo').addEventListener('click', function () { el('file-input').click(); });
  el('file-input').addEventListener('change', function () {
    var f = el('file-input').files && el('file-input').files[0];
    el('file-input').value = '';
    if (f) openCrop(f);
  });

  wireCropGestures();

  el('crop-cancel').addEventListener('click', function () { crop = null; show('s-avatar'); });
  el('crop-done').addEventListener('click', function () {
    if (!crop) { show('s-avatar'); return; }
    var btn = el('crop-done');
    busy(btn, true, 'Готовим…');
    cropToBlob().then(function (blob) {
      customBlob = blob;
      el('own-img').src = URL.createObjectURL(blob);
      el('own-wrap').hidden = false;
      crop = null;
      busy(btn, false);
      show('s-avatar');
      pickAvatar(el('own-ava'));
    }).catch(function (e) {
      busy(btn, false);
      crop = null;
      show('s-avatar');
      setErr('err-avatar', 'Не получилось обрезать снимок: ' + e.message);
    });
  });

  el('own-ava').addEventListener('click', function () { pickAvatar(el('own-ava')); });

  el('log-go').addEventListener('click', loginGo);
  el('blocked-home').addEventListener('click', function () { forgetGuest(); startScreen(); });

  // --- лента ---
  el('btn-plus').addEventListener('click', plusTap);
  el('btn-me').addEventListener('click', function () { if (me) openGuest(me.id, true); });
  el('guest-back').addEventListener('click', function () { history.back(); });
  el('newbar').addEventListener('click', function () {
    el('newbar').hidden = true;
    feedReload();
  });

  // --- загрузка ---
  el('up-pick').addEventListener('click', function () { el('up-input').click(); });
  el('up-input').addEventListener('change', function () {
    var list = el('up-input').files;
    upPick(list);
    el('up-input').value = '';        // чтобы те же снимки можно было выбрать снова
  });
  el('up-retry').addEventListener('click', upRetry);
  el('up-back').addEventListener('click', function () { history.back(); });
  el('up-tofeed').addEventListener('click', function () { history.back(); });

  // --- шторка комментариев ---
  wireSheetDrag();
  wireKeyboard();
  el('say-go').addEventListener('click', saySend);
  el('say-input').addEventListener('input', sayLeft);
  el('say-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); saySend(); }
  });

  // --- лента гостя и выход ---
  el('gfeed-back').addEventListener('click', function () { history.back(); });
  el('btn-exit').addEventListener('click', tapExit);
  el('ask-yes').addEventListener('click', function () { askClose(true); });
  el('ask-no').addEventListener('click', function () { askClose(false); });
  el('ask-back').addEventListener('click', function () { askClose(false); });

  /* Возврат кнопкой браузера и жестом «назад» на айфоне. Порядок важен:
     сначала закрываем то, что лежит поверх экранов, и только потом
     переключаем сами экраны. */
  window.addEventListener('popstate', function (e) {
    var s = e.state;

    // ответ на наш собственный history.back() при закрытии шторки: она уже ушла
    if (sheet.backPending) { sheet.backPending = false; return; }

    if (sheet.open && !(s && s.sheet)) { sheet.pushed = false; sheetHide(); return; }
    if (s && s.sheet) { openSheet(s.sheet, false); return; }

    if (s && s.gfeed) { openGuestFeed(s.gfeed, s.photo, false); return; }

    if (s && s.guest) {
      // карточка уже собрана — возвращаемся на неё, не перечитывая заново
      if (shownGuest === s.guest && el('s-gfeed').classList.contains('is-on')) backToGuest();
      else openGuest(s.guest, false);
      return;
    }

    if (el('s-guest').classList.contains('is-on')) backToFeed();
    else if (el('s-upload').classList.contains('is-on')) backToFeed();
    else if (el('s-gfeed').classList.contains('is-on')) backToFeed();
  });

  refreshLogin();
  boot();
}

/* Сначала выясняем, работает ли сайт вообще: после 8 августа вместо всех
   экранов остаётся одна страница благодарности. Границы берём из базы,
   но не ждём её — запасные значения уже стоят, а придут настоящие — пересчитаем. */
function boot() {
  if (siteState() === 'closed') { show('s-closed'); }
  else { restoreSession(); }

  loadBounds().then(function () {
    if (siteState() === 'closed') { show('s-closed'); return; }
    if (el('s-closed').classList.contains('is-on')) { restoreSession(); return; }
    if (el('s-feed').classList.contains('is-on')) applyState();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
