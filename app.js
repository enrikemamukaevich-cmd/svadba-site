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
  UP_TIMEOUT_MS: 45000             // отправка тяжелее чтения, срок ожидания длиннее
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
  return '';
}

function normWord(s) {
  return String(s || '').trim().toLowerCase().replace(/ё/g, 'е');
}

function wordOk(s) {
  return normWord(s) === normWord(CONFIG.CODE_WORD);
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

var fmtTime = null, fmtDate = null;

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

function longDate(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    if (!fmtDate) fmtDate = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow'
    });
    return fmtDate.format(d).replace(/\s*г\.\s*$/, '');   // «4 августа 2026 г.» → без «г.»
  } catch (e) {
    return d.toISOString().slice(0, 10);
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

// id.desc — запасной порядок: если у двух снимков совпало время, страницы
// не должны разъезжаться при подгрузке
function fetchPage(offset, limit) {
  return restGet('photos?select=id,guest_id,preview_path,created_at' +
                 '&hidden=eq.false&order=created_at.desc,id.desc' +
                 '&offset=' + offset + '&limit=' + limit)
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

  card.appendChild(top);
  card.appendChild(shot);
  return card;
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

var feed = {
  offset: 0,
  done: false,
  busy: false,
  newest: null,     // время самого свежего показанного снимка
  waiting: 0,       // сколько новых чужих снимков ждёт за плашкой
  scrollY: 0,       // где оставили ленту, уходя на карточку гостя
  watcher: null,
  poller: null
};

function feedReset() {
  feed.offset = 0;
  feed.done = false;
  feed.busy = false;
  feed.newest = null;
  feed.waiting = 0;
  el('feed').innerHTML = '';
  el('feed-empty').hidden = true;
  el('newbar').hidden = true;
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

function feedMore() {
  if (feed.busy || feed.done) return Promise.resolve();
  feed.busy = true;

  var list = el('feed');
  var skels = [];
  for (var i = 0; i < 3; i++) { var s = skeletonNode(); skels.push(s); list.appendChild(s); }

  return fetchPage(feed.offset, CONFIG.PAGE).then(function (rows) {
    rows = rows || [];
    return ensureGuests(rows).then(function () { return rows; });
  }).then(function (rows) {
    skels.forEach(function (s) { s.remove(); });

    rows.forEach(function (row) {
      list.appendChild(cardNode(row));
      if (!feed.newest || row.created_at > feed.newest) feed.newest = row.created_at;
    });

    feed.offset += rows.length;
    if (rows.length < CONFIG.PAGE) feed.done = true;
    feed.busy = false;

    el('feed-empty').hidden = !(feed.offset === 0 && feed.done);

    // экран высокий, а порция короткая — досыпаем, пока не появится прокрутка
    if (!feed.done && document.body.scrollHeight <= window.innerHeight + 40) return feedMore();
  }).catch(function () {
    skels.forEach(function (s) { s.remove(); });
    feed.busy = false;
    el('feed-count').textContent = 'Лента не загрузилась. Потяните вниз и обновите страницу.';
  });
}

function feedWatch() {
  if (feed.watcher || !('IntersectionObserver' in window)) return;
  feed.watcher = new IntersectionObserver(function (entries) {
    if (entries.some(function (e) { return e.isIntersecting; })) feedMore();
  }, { rootMargin: '400px 0px' });
  feed.watcher.observe(el('feed-tail'));
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
  feedReset();
  feedRefreshCount();
  return feedMore().then(function () { window.scrollTo(0, 0); });
}

/* Только что отправленный снимок встаёт в начало ленты сам, без перечитывания
   всех порций: гость отправляет десять штук подряд и должен видеть каждую
   сразу, а не ждать конца очереди. Сдвигаем и offset — иначе следующая порция
   вернёт снимок, который уже стоит на экране. */
function feedPrepend(row) {
  if (!row || !row.preview_path) return;
  var list = el('feed');
  if (list.querySelector('.card[data-id="' + row.id + '"]')) return;

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
    feedWatch();
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
  el('guest-since').textContent = g.created_at ? ('с нами с ' + longDate(g.created_at)) : '';
}

/* Чья карточка открыта прямо сейчас. Пока идут запросы, гость успевает
   открыть другую — опоздавший ответ не должен затирать свежую. */
var shownGuest = null;

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

  // куда вернуть ленту, когда гость нажмёт «назад»
  if (el('s-feed').classList.contains('is-on')) feed.scrollY = window.scrollY;

  show('s-guest');
  if (push) {
    try { history.pushState({ guest: id }, '', location.href); } catch (e) { /* переживём */ }
  }

  restGet('photos?select=id,preview_path,created_at&hidden=eq.false&guest_id=eq.' +
          encodeURIComponent(id) + '&order=created_at.desc,id.desc')
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      if (shownGuest !== id) return null;
      rows = rows || [];
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

function cellNode(row, mine) {
  var cell = document.createElement('div');
  cell.className = 'cell';

  var shot = document.createElement('div');
  shot.className = 'cell-shot';
  var img = document.createElement('img');
  img.src = photoUrl(row.preview_path);
  img.alt = '';
  img.loading = 'lazy';
  shot.appendChild(img);
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
  show('s-feed');
  // лента возвращается туда же, где её оставили, а не в начало
  window.scrollTo(0, feed.scrollY || 0);
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

  // возврат кнопкой браузера и жестом «назад» на айфоне
  window.addEventListener('popstate', function (e) {
    var s = e.state;
    if (s && s.guest) openGuest(s.guest, false);
    else if (el('s-guest').classList.contains('is-on')) backToFeed();
    else if (el('s-upload').classList.contains('is-on')) backToFeed();
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
