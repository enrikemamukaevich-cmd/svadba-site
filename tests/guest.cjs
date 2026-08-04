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

module.exports = { loadGuest: loadGuest };
