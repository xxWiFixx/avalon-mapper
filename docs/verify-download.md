# Проверка установщика

Официальные выпуски: [xxWiFixx/avalon-mapper](https://github.com/xxWiFixx/avalon-mapper/releases). Не использовать перепакованные установщики из сторонних источников.

## Новые сборки GitHub Actions

Процесс **Verified Windows build** запускается вручную для ветки main. Он устанавливает зависимости из lock-файла, проверяет уязвимости, выполняет тесты и собирает Windows x64. Отдельное задание создаёт подтверждение происхождения файлов; задание сборки не получает право выпускать такие подтверждения.

Результат содержит установщик, SHA256SUMS, сведения о коммите и запуске в build-info.json и список зависимостей сборки в dependencies.cdx.json. Артефакты доступны 14 дней. Процесс не публикует и не заменяет Releases автоматически. При публикации переносится тот же установщик без повторной сборки.

В PowerShell проверить хеш скачанного файла и сравнить с SHA256SUMS:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\AvalonMapper-<версия>-setup.exe'
```

Подтверждение происхождения проверяется через GitHub CLI:

```powershell
gh attestation verify '.\AvalonMapper-<версия>-setup.exe' --repo xxWiFixx/avalon-mapper --signer-workflow xxWiFixx/avalon-mapper/.github/workflows/build.yml
```

Хеш выявляет изменение файла. Подтверждение GitHub связывает файл с репозиторием и процессом сборки. Ни одна из этих проверок не доказывает отсутствие ошибок или вредоносного кода. [Документация GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Старые выпуски и подпись

Выпуски до внедрения этого процесса, включая 0.4.0, собраны локально и не имеют подтверждения GitHub. Эти проверки нельзя приписывать им задним числом.

Подпись издателя Windows пока отсутствует. После её внедрения проверка должна показывать действующую подпись ожидаемого издателя:

```powershell
Get-AuthenticodeSignature -LiteralPath '.\AvalonMapper-<версия>-setup.exe'
```

Подпись подтверждает издателя и целостность файла; она не гарантирует немедленного исчезновения предупреждений SmartScreen. [Документация Microsoft](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).
