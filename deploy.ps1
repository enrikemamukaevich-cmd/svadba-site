# ============================================================================
# Заливка сайта через GitHub.
#
# Раньше здесь был scp прямо на сервер. Он перестал работать: на машине поднят
# VPN-туннель happ-tun, он держит весь трафик и до 201.34.133.135 не доходит.
# Выключить туннель нельзя — через него работает Claude Code. Поэтому правки
# уходят в репозиторий, а сервер раз в минуту сам подтягивает их себе.
#
# Запуск из папки проекта:  powershell -ExecutionPolicy Bypass -File deploy.ps1
# Можно с подписью коммита: ... -File deploy.ps1 -Message "что поменял"
# ============================================================================

[CmdletBinding()]
param(
  [string]$Message = '',
  [switch]$Scp          # старый способ, напрямую по scp — только если туннель снят
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$site = 'https://ripsigal-jimbei.ru/'

# ----------------------------------------------------------------------------
# Предупреждение про туннель. Стоит первым: если поднят happ-tun, то старый
# способ гарантированно повиснет на двадцать секунд и упадёт, а человек будет
# думать, что сломался сервер. Лучше сказать об этом сразу и прямо.
# ----------------------------------------------------------------------------

$tun = Get-NetAdapter -ErrorAction SilentlyContinue |
       Where-Object { $_.Status -eq 'Up' -and ($_.Name -match 'happ|tun' -or $_.InterfaceDescription -match 'sing-tun|wintun|TAP|WireGuard') }

if ($tun) {
  Write-Host ''
  Write-Host 'Внимание: поднят VPN-туннель.' -ForegroundColor Yellow
  $tun | ForEach-Object { Write-Host ("  адаптер {0} — {1}" -f $_.Name, $_.InterfaceDescription) }
  Write-Host '  До 201.34.133.135 через него не пройти: TCP-рукопожатие завершает сам'
  Write-Host '  туннель, а дальше ничего не идёт. Заливка идёт через GitHub.'
  Write-Host ''

  if ($Scp) {
    Write-Host 'Остановлено. Запрошен старый способ (-Scp), но при поднятом туннеле' -ForegroundColor Red
    Write-Host 'он не сработает: scp повиснет и упадёт с "banner exchange".' -ForegroundColor Red
    Write-Host 'Либо снимите туннель, либо запускайте без -Scp — через GitHub.' -ForegroundColor Red
    exit 1
  }
}

# ----------------------------------------------------------------------------
# Старый способ. Оставлен на случай, когда туннеля нет и хочется залить сразу.
# ----------------------------------------------------------------------------

if ($Scp) {
  Write-Host 'Заливаю напрямую по scp...'
  $key   = 'C:\Users\Public\svadba-ssh\id_ed25519'
  $known = 'C:\Users\Public\svadba-ssh\known_hosts'
  $dest  = 'root@201.34.133.135:/var/www/svadba/'

  # Windows-овский scp.exe отказывается брать ключ из C:\Users\Public: по его
  # меркам файл открыт всем. Берём scp из комплекта Git, он считает права иначе.
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

  & $scp @opts @files $dest
  if ($LASTEXITCODE -ne 0) { throw "scp вернул $LASTEXITCODE" }
  & $scp @opts -r (Join-Path $root 'img') $dest
  if ($LASTEXITCODE -ne 0) { throw "scp вернул $LASTEXITCODE" }

  Write-Host 'Залито напрямую.'
  exit 0
}

# ----------------------------------------------------------------------------
# Обычный способ: коммит и отправка в GitHub
# ----------------------------------------------------------------------------

Set-Location $root

if (-not (Test-Path (Join-Path $root '.git'))) {
  throw 'В папке нет репозитория. Выполните git init и привяжите GitHub.'
}

# git пишет часть обычных сообщений в поток ошибок, а при 'Stop' это роняет
# скрипт на ровном месте. Дальше следим за кодами возврата руками.
$ErrorActionPreference = 'Continue'

$remotes = @(git remote)
if ($remotes -notcontains 'origin') {
  Write-Host ''
  Write-Host 'Не привязан GitHub. Один раз выполните:' -ForegroundColor Red
  Write-Host '  git remote add origin https://github.com/ВАШ-ЛОГИН/svadba-site.git'
  Write-Host '  git push -u origin main'
  exit 1
}

# Что именно меняем — показываем до отправки, чтобы не улетело лишнее
$changes = git status --porcelain
if ($changes) {
  Write-Host 'Изменения:'
  $changes | ForEach-Object { Write-Host "  $_" }

  if (-not $Message) {
    $Message = 'Правки сайта ' + (Get-Date -Format 'dd.MM.yyyy HH:mm')
  }
  git add -A
  if ($LASTEXITCODE -ne 0) { Write-Host "git add вернул $LASTEXITCODE" -ForegroundColor Red; exit 1 }
  git commit -q -m $Message
  if ($LASTEXITCODE -ne 0) { Write-Host "git commit вернул $LASTEXITCODE" -ForegroundColor Red; exit 1 }
  Write-Host "Коммит: $Message"
} else {
  Write-Host 'Менять нечего, отправляю то, что уже закоммичено.'
}

Write-Host 'Отправляю в GitHub...'
git push origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host "git push вернул $LASTEXITCODE. Правки остались только на этой машине." -ForegroundColor Red
  Write-Host 'Проверьте доступ к GitHub: git push origin main' -ForegroundColor Red
  exit 1
}

$sha = (git rev-parse --short HEAD)
Write-Host "Отправлено, коммит $sha."

# ----------------------------------------------------------------------------
# Ждём, пока сервер подтянет правки, и проверяем боевой адрес
# ----------------------------------------------------------------------------

Write-Host ''
Write-Host 'Сервер тянет обновления раз в минуту. Жду и проверяю боевой адрес...'

# Метка, по которой узнаём, что на сервере уже новая версия. Берём её из
# app.js: номер коммита туда не вписать, а вот содержимое сверить можно.
$localJs = Get-Content (Join-Path $root 'app.js') -Raw
$mark = if ($localJs -match 'ЗАГРУЗКА ФОТО|openUpload') { 'openUpload' } else { $null }

$okDeploy = $false
for ($i = 1; $i -le 15; $i++) {
  Start-Sleep -Seconds 10
  try {
    $r = Invoke-WebRequest ($site + 'app.js?t=' + [DateTimeOffset]::Now.ToUnixTimeSeconds()) `
         -UseBasicParsing -TimeoutSec 15
    if ($r.StatusCode -eq 200) {
      if (-not $mark -or $r.Content -match $mark) {
        Write-Host ("Готово: боевой адрес отдаёт новую версию (проверка {0})." -f $i) -ForegroundColor Green
        $okDeploy = $true
        break
      }
      Write-Host ("  {0}: сервер отвечает, но версия ещё старая" -f $i)
    }
  } catch {
    Write-Host ("  {0}: адрес пока не отвечает" -f $i)
  }
}

if (-not $okDeploy) {
  Write-Host ''
  Write-Host 'Правки в GitHub ушли, но подтвердить боевой адрес не вышло.' -ForegroundColor Yellow
  if ($tun) {
    Write-Host 'Скорее всего мешает тот самый туннель: проверить сайт с этой машины'
    Write-Host 'нельзя, даже когда сервер уже обновился. Откройте сайт с телефона.'
  } else {
    Write-Host 'Проверьте задание cron на сервере: crontab -l'
  }
  exit 2
}

Write-Host ''
Write-Host "Проверить глазами: $site"
