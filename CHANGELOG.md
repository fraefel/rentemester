# Changelog

Alle væsentlige ændringer i Rentemester dokumenteres her. Formatet følger
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), og produktversioner
følger [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Plads til ændringer, der endnu ikke indgår i en godkendt release.

## [0.2.0] - 2026-08-24

### Added

- Hosted login med Better Auth, TOTP-MFA, recovery codes, sessionslukning og
  server-side adgangskontrol på tværs af virksomheder.
- Roller, invitationer, virksomhedsskifter og revisionsspor for handlinger i
  webinterfacet.
- Kontrollerede bogføringskladder, review, dokumenthåndtering, snapshots og
  generiske health-, readiness- og restore-kontroller.
- Koncernstruktur, mellemregning, elimineringer og read-only konsolidering,
  mens hver juridisk enhed beholder sin egen ledger.
- Bun 1.4-native cockpit-build og et reproducerbart, non-root OCI-image med
  release-evidens, SBOM og attestering.

### Changed

- Den fulde backend- og cockpittestkæde køres lokalt og parallelt via
  `bun run verify:local`; GitHub verificerer build, containerkontrakt og
  reproducerbarhed og publicerer kandidat-imaget uden at gentage tusindvis af
  domænetests.
- Produktet kan køre både som enkelt lokalt workspace og som hosted løsning
  med flere virksomheder og flere ejere.
- Cockpittet accepterer den dokumenterede `local-container`-profil som lokal
  drift uden Better Auth; release-gaten renderer nu den publicerede profil i
  en rigtig headless browser.

### Security

- Tilføjet fail-closed virksomhedsskel, rolle- og MFA-kontroller, sikre
  cookies, CSRF-beskyttelse, login-rate-limit og private dokumentdownloads.
- Dependency-, licens- og containerkontroller indgår i release-gaten.

## [0.1.0] - 2026-07-19

### Added

- Første kanoniske SemVer på tværs af CLI, MCP, HTTP API og cockpit.
- Build-identitet med Git-commit og deterministisk buildtid i release-images.
- Checksummet schema-baseline med afvisning af databaser fra nyere software.
- Deterministisk SHA-256-identitet for regler og juridiske kildefiler.
- Versions- og regelproveniens i backups, myndighedseksport og SAF-T-eksport.
- Multi-stage, non-root Docker-image med cockpit, runtime, regler og kilder.
- To-trins GHCR-releaseflow: kandidatimage og digest-bundet Digisense-promovering.
- Selvstændig CI for det separate `www`-site.

### Changed

- CI bruger den fastlåste Bun-version 1.3.14 i stedet for `latest`.
- Docker Compose-eksemplet kræver et eksplicit digest-pinnet image og bruger
  aldrig `latest`.

[Unreleased]: https://github.com/mikkelkrogsholm/rentemester/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mikkelkrogsholm/rentemester/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mikkelkrogsholm/rentemester/releases/tag/v0.1.0
