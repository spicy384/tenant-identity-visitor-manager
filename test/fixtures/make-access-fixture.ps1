# Makes test/fixtures/directory.mdb, the Access database the import tests read. Run it with
# 32-bit Windows PowerShell, which has the Jet engine that ships with Windows:
#
#   & "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File test\fixtures\make-access-fixture.ps1
#
# The column names deliberately differ from the app's, so the import has to match them.
$ErrorActionPreference = "Stop"
$path = Join-Path $PSScriptRoot "directory.mdb"
if (Test-Path $path) { Remove-Item $path }
$catalog = New-Object -ComObject ADOX.Catalog
$null = $catalog.Create("Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$path")
$db = $catalog.ActiveConnection

$null = $db.Execute("CREATE TABLE Firms (FirmID COUNTER PRIMARY KEY, FirmName TEXT(100), Building TEXT(50), Suite TEXT(50), MainPhone TEXT(30))")
$null = $db.Execute("CREATE TABLE [Tenant Staff] (StaffID COUNTER PRIMARY KEY, FirstName TEXT(50), Surname TEXT(50), Firm TEXT(100), EMail TEXT(100), DeskPhone TEXT(30), Title TEXT(80), StartDate DATETIME, IsCurrent YESNO, Notes MEMO)")

$firms = @(
  @("Acme Corp", "Harbour Point", "Suite 100", "555-0100"),
  @("Globex", "Harbour Point", "Suite 200", "555-0200")
)
foreach ($f in $firms) {
  $null = $db.Execute("INSERT INTO Firms (FirmName, Building, Suite, MainPhone) VALUES ('$($f[0])', '$($f[1])', '$($f[2])', '$($f[3])')")
}

# Accented names are written with SQL CHR() so this file stays plain ASCII.
$staff = @(
  "'Ada', 'Lovelace', 'Acme Corp', 'ada@acme.example', '555-0101', 'Engineer', #2024-03-01#, True, 'Prefers mornings'",
  "'Jos' & CHR(233), 'N' & CHR(250) & CHR(241) & 'ez', 'Acme Corp', 'jose@acme.example', '555-0102', 'Analyst', #2023-11-15#, True, NULL",
  "'Grace', 'Hopper', 'Globex', NULL, '555-0201', 'Director', #2022-06-30#, False, NULL",
  "'Alan', 'Turing', 'Initech', 'alan@initech.example', NULL, 'Researcher', NULL, True, NULL"
)
foreach ($s in $staff) {
  $null = $db.Execute("INSERT INTO [Tenant Staff] (FirstName, Surname, Firm, EMail, DeskPhone, Title, StartDate, IsCurrent, Notes) VALUES ($s)")
}
$db.Close()
"Wrote $path"
