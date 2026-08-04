/* ============================================================================
   Тестовый гость для проверок этапов 3 и 4.

   Раньше его данные, включая скрытый ключ secret, лежали прямо в файлах
   проверок. Пока папка проекта никуда не уходила, это было терпимо, но с
   появлением репозитория так нельзя: secret подтверждает право удалять свои
   снимки, и в открытом виде ему не место. Теперь он читается из
   tests/guest.local.json — этот файл в репозиторий не попадает.

   Заводится один раз копированием из guest.example.json.
   ============================================================================ */

var path = require('path');
var fs = require('fs');

var LOCAL = path.join(__dirname, 'guest.local.json');

function loadGuest() {
  if (!fs.existsSync(LOCAL)) {
    console.error(
      '\nНет файла tests/guest.local.json — без него проверки не знают,\n' +
      'под каким гостем смотреть ленту.\n\n' +
      'Скопируйте образец и впишите настоящие значения:\n' +
      '  copy tests\\guest.example.json tests\\guest.local.json\n');
    process.exit(2);
  }

  var g;
  try {
    g = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  } catch (e) {
    console.error('\ntests/guest.local.json не читается: ' + e.message + '\n');
    process.exit(2);
  }

  var need = ['id', 'nick', 'avatar_kind', 'avatar_value', 'secret'];
  var missing = need.filter(function (k) { return !g[k]; });
  if (missing.length) {
    console.error('\nВ tests/guest.local.json не хватает полей: ' + missing.join(', ') + '\n');
    process.exit(2);
  }
  if (/^ВПИШИТЕ/.test(g.secret) || /^ВПИШИТЕ/.test(g.id)) {
    console.error('\nВ tests/guest.local.json остались заглушки из образца — впишите настоящие значения.\n');
    process.exit(2);
  }
  return g;
}

/* Проверкам этапа 5 одного гостя мало: чужой комментарий надо попробовать
   удалить от другого лица, три жалобы должны прийти от трёх разных гостей,
   а забаненному положено получить отказ. Эти трое заведены в базе один раз
   и лежат в том же guest.local.json — их ключи такие же тайные.

   Если их там нет, проверки этапа 5 сами объяснят, что делать: завести
   гостей обычной регистрацией на сайте и вписать сюда, а «тест-бан»
   вдобавок пометить в базе banned = true — публичным ключом это не делается
   и не должно делаться. */
function loadMates() {
  var g = loadGuest();
  var need = ['mate', 'mate2', 'banned'];
  var missing = need.filter(function (k) { return !(g[k] && g[k].secret && g[k].id); });
  if (missing.length) {
    console.error(
      '\nВ tests/guest.local.json не хватает вспомогательных гостей: ' + missing.join(', ') + '\n\n' +
      'Заведите их регистрацией на сайте (пин 1234) и добавьте в файл:\n' +
      '  "mate":   { "id": "…", "nick": "тест-друг",   "avatar_kind": "preset", "avatar_value": "2", "secret": "…" },\n' +
      '  "mate2":  { "id": "…", "nick": "тест-третий", "avatar_kind": "preset", "avatar_value": "3", "secret": "…" },\n' +
      '  "banned": { "id": "…", "nick": "тест-бан",    "avatar_kind": "preset", "avatar_value": "5", "secret": "…" }\n\n' +
      'Последнему один раз выполните в SQL-редакторе Supabase:\n' +
      "  update guests set banned = true where nick_key = 'тест-бан';\n");
    process.exit(2);
  }
  return { me: g, mate: g.mate, mate2: g.mate2, banned: g.banned };
}

module.exports = { loadGuest: loadGuest, loadMates: loadMates };
