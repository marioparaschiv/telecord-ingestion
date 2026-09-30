# Installs the telecord-ingestion CLI, then runs its setup with any arguments given.
#
#   irm https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.ps1))) --yes

# iex runs this in the caller's session, so everything stays inside this scope and
# errors are reported rather than calling exit, which would close their window.
& {
	$ErrorActionPreference = 'Stop'
	# The progress bar slows downloads to a crawl in Windows PowerShell 5.1.
	$ProgressPreference = 'SilentlyContinue'
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$Name = 'telecord-ingestion'
	$Asset = "$Name-windows-x64.exe"
	$Releases = if ($env:TELECORD_INGESTION_RELEASES) { $env:TELECORD_INGESTION_RELEASES } else { 'https://api.github.com/repos/marioparaschiv/telecord-ingestion/releases' }
	$Headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = $Name }
	$BinDir = Join-Path $env:LOCALAPPDATA "Programs\$Name"
	$Exe = Join-Path $BinDir "$Name.exe"

	function Write-Step([string] $Message) {
		Write-Host
		Write-Host $Message -ForegroundColor Cyan
	}

	function Write-Ok([string] $Message) {
		Write-Host '  ' -NoNewline
		Write-Host ([char] 0x2713) -ForegroundColor Cyan -NoNewline
		Write-Host " $Message"
	}

	function Get-Asset($Release, [string] $File, [string] $Destination) {
		$match = $Release.assets | Where-Object { $_.name -eq $File } | Select-Object -First 1

		if (-not $match) {
			throw "Release $($Release.tag_name) has no $File."
		}

		try {
			Invoke-WebRequest -Uri $match.browser_download_url -OutFile $Destination -Headers @{ 'User-Agent' = $Name } -UseBasicParsing
		} catch {
			throw "Could not download $File from $($match.browser_download_url): $($_.Exception.Message)"
		}
	}

	# Writes the unexpanded registry value, since [Environment]::SetEnvironmentVariable
	# would expand entries like %USERPROFILE% in the user's other PATH entries.
	function Add-ToUserPath([string] $Directory) {
		$key = Get-Item -Path 'HKCU:\Environment'
		$current = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
		$entries = @($current -split ';' | Where-Object { $_ })

		if ($entries -contains $Directory) {
			return
		}

		Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Type ExpandString -Value (($entries + $Directory) -join ';')

		# Setting any variable through .NET broadcasts WM_SETTINGCHANGE, so new terminals see the PATH.
		$probe = "$Name-" + [guid]::NewGuid().ToString()
		[Environment]::SetEnvironmentVariable($probe, '1', 'User')
		[Environment]::SetEnvironmentVariable($probe, [NullString]::Value, 'User')

		Write-Ok "Added $Directory to your PATH"
		Write-Host "  Open a new terminal to run $Name by name." -ForegroundColor DarkGray
	}

	function Install-Cli([string[]] $Arguments) {
		Write-Host
		Write-Host '  Telecord Ingestion' -ForegroundColor Cyan

		Write-Step '1. Finding the latest release'

		$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }

		# Windows on Arm runs the x64 build under emulation.
		if ($arch -notin 'AMD64', 'ARM64') {
			throw "No $Name build for the $arch architecture."
		}

		try {
			$list = Invoke-RestMethod -Uri "$($Releases)?per_page=100" -Headers $Headers -UseBasicParsing
		} catch {
			throw "Could not list the releases at $($Releases): $($_.Exception.Message)"
		}

		# Enumerated with foreach, since Windows PowerShell 5.1 pipes a JSON array as one object.
		$release = $null

		foreach ($candidate in $list) {
			if ($candidate.tag_name -match '^cli-v\d+\.\d+\.\d+' -and -not $candidate.draft -and -not $candidate.prerelease) {
				$release = $candidate
				break
			}
		}

		if (-not $release) {
			throw "No stable $Name release found at $Releases"
		}

		Write-Ok "$Name $($release.tag_name.Substring(5)) for windows-x64"

		Write-Step '2. Downloading'

		New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
		$staging = Join-Path $BinDir ".$Name-$([guid]::NewGuid().ToString('N'))"
		New-Item -ItemType Directory -Path $staging | Out-Null

		try {
			Get-Asset $release 'checksums.txt' (Join-Path $staging 'checksums.txt')
			Get-Asset $release $Asset (Join-Path $staging $Asset)

			$expected = $null

			foreach ($line in Get-Content (Join-Path $staging 'checksums.txt')) {
				if ($line -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2] -eq $Asset) {
					$expected = $Matches[1].ToLowerInvariant()
					break
				}
			}

			if (-not $expected) {
				throw "checksums.txt lists no checksum for $Asset"
			}

			$actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $staging $Asset)).Hash.ToLowerInvariant()

			if ($actual -ne $expected) {
				throw "Checksum mismatch for $($Asset): expected $expected, got $actual. Nothing was installed."
			}

			Write-Ok 'Checksum verified'

			Write-Step '3. Installing'

			# A running exe can be renamed but not overwritten; the CLI deletes the .old on its next run.
			if (Test-Path $Exe) {
				if (Test-Path "$Exe.old") {
					Remove-Item -Force -Path "$Exe.old"
				}

				Move-Item -Force -Path $Exe -Destination "$Exe.old"
			}

			Move-Item -Path (Join-Path $staging $Asset) -Destination $Exe
		} finally {
			Remove-Item -Recurse -Force -Path $staging
		}

		Write-Ok "Installed $Exe"

		Add-ToUserPath $BinDir

		if (($env:Path -split ';') -notcontains $BinDir) {
			$env:Path = "$BinDir;$env:Path"
		}

		Write-Step '4. Setting up'

		& $Exe setup @Arguments
	}

	try {
		Install-Cli $args
	} catch {
		Write-Host
		Write-Host 'Error: ' -ForegroundColor Red -NoNewline
		Write-Host $_.Exception.Message
		$global:LASTEXITCODE = 1
	}
} @args
