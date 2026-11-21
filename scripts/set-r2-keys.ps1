# Ghi key Cloudflare R2 vao .env va bat tu dong chuyen crop/keyframe len bucket (docs/CLOUD_STORAGE.md).
# Key go vao khong hien tren man hinh va chi duoc ghi vao .env tren may nay.
#   powershell -ExecutionPolicy Bypass -File scripts\set-r2-keys.ps1
# Sau do dong 2 cua so API va WORKER roi chay lai scripts\start-all.ps1 -NoBrowser.
$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $backend '.env'
if (-not (Test-Path $envFile)) { throw "Khong thay $envFile (chep tu .env.example truoc)." }

$account = (Read-Host 'Account ID (32 ky tu, trang R2 > Overview)').Trim()
$bucket = (Read-Host 'Ten bucket [plate-evidence]').Trim()
if (-not $bucket) { $bucket = 'plate-evidence' }
$keyId = (Read-Host 'Access Key ID').Trim()
$secure = Read-Host 'Secret Access Key (an khi go)' -AsSecureString
$hours = (Read-Host 'Chuyen anh len bucket sau bao nhieu gio [1]').Trim()
if (-not $hours) { $hours = '1' }
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

if ($account -notmatch '^[0-9a-fA-F]{32}$') { throw 'Account ID phai la 32 ky tu hex.' }
if (-not $keyId -or -not $secret) { throw 'Thieu Access Key ID hoac Secret.' }
if ($hours -notmatch '^\d+(\.\d+)?$') { throw 'So gio phai la so (vi du 1 hoac 24).' }

$names = 'PLATE_R2_ACCOUNT_ID', 'PLATE_S3_ENDPOINT', 'PLATE_S3_BUCKET', 'PLATE_S3_ACCESS_KEY_ID',
  'PLATE_S3_SECRET_ACCESS_KEY', 'PLATE_CLOUD_EVIDENCE_AFTER_HOURS'
$pattern = '^\s*(' + ($names -join '|') + ')\s*='
$lines = @([IO.File]::ReadAllLines($envFile) | Where-Object { $_ -notmatch $pattern })
$lines += @(
  "PLATE_R2_ACCOUNT_ID=$account",
  "PLATE_S3_BUCKET=$bucket",
  "PLATE_S3_ACCESS_KEY_ID=$keyId",
  "PLATE_S3_SECRET_ACCESS_KEY=$secret",
  "PLATE_CLOUD_EVIDENCE_AFTER_HOURS=$hours"
)
[IO.File]::WriteAllText($envFile, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
Remove-Variable secret
Write-Host 'Da ghi vao .env. Dang kiem tra ket noi R2...' -ForegroundColor Green
Push-Location $backend
try { npm run cloud:check } finally { Pop-Location }
Write-Host 'Neu thanh cong: dong 2 cua so API va WORKER roi chay scripts\start-all.ps1 -NoBrowser.' -ForegroundColor Yellow
