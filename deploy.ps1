# Заливка сайта на сервер Timeweb Cloud.
# Запуск из папки проекта:  powershell -ExecutionPolicy Bypass -File deploy.ps1
#
# Про выбор scp. Windows-овский C:\Windows\System32\OpenSSH\scp.exe отказывается
# брать ключ из C:\Users\Public — по его меркам файл открыт всем и потому «плохой»,
# после отказа он молча просит пароль и висит. Права на ключе менять нельзя,
# поэтому берём scp из комплекта Git: он тот же OpenSSH, но права считает
# по-своему и с этим ключом работает.

$ErrorActionPreference = 'Stop'

$key   = 'C:\Users\Public\svadba-ssh\id_ed25519'
$known = 'C:\Users\Public\svadba-ssh\known_hosts'
$dest  = 'root@201.34.133.135:/var/www/svadba/'
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path

$scp = 'C:\Program Files\Git\usr\bin\scp.exe'
if (-not (Test-Path $scp)) { $scp = 'scp' }

$opts = @(
  '-i', $key,
  '-o', "UserKnownHostsFile=$known",
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=20'
)

$files = @('index.html', 'app.js', 'styles.css') | ForEach-Object { Join-Path $root $_ }

Write-Host 'Заливаю страницы...'
& $scp @opts @files $dest
if ($LASTEXITCODE -ne 0) { throw "scp вернул $LASTEXITCODE" }

Write-Host 'Заливаю картинки аватарок...'
& $scp @opts -r (Join-Path $root 'img') $dest
if ($LASTEXITCODE -ne 0) { throw "scp вернул $LASTEXITCODE" }

Write-Host 'Готово. Проверить: https://ripsigal-jimbei.ru/'
