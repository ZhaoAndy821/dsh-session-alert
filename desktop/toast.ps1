<#
  toast.ps1 - raise a native Windows toast for the DSH desktop alert bridge.

  Windows attributes a toast to the AppUserModelID it is raised under, so this
  uses com.deepseek.dsh - the id the installed "DeepSeek Harness" desktop app
  registers through its Start Menu shortcut - and the notification appears as
  "DeepSeek Harness" with the app icon, next to WorkBuddy's own toasts. It also
  lands in the Action Center, which the always-on-top card cannot do.

  Windows PowerShell 5.1 is required: pwsh 7 cannot project the WinRT types.

  ASCII-only on purpose; the localized strings arrive in the -Payload JSON file.

  -Remove deletes the matching entry from the Action Center instead of raising a
  new toast: the bridge tags every toast with a short hash of the session id, so
  a waiting interaction that the user already answered does not leave a stale
  "session needs you" row behind.

  usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File toast.ps1 -Payload <file.json> [-Remove]
#>
param(
  [Parameter(Mandatory = $true)][string]$Payload,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$cfg = [System.IO.File]::ReadAllText($Payload, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

$appId = 'com.deepseek.dsh'
if ($cfg.appId) { $appId = [string]$cfg.appId }
$title = if ($cfg.title) { [string]$cfg.title } else { 'DSH' }
$body = if ($cfg.body) { [string]$cfg.body } else { '' }

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$null = $texts.Item(0).AppendChild($template.CreateTextNode($title))
$null = $texts.Item(1).AppendChild($template.CreateTextNode($body))

$tag = 'dsh-desktop-alert'
if ($cfg.tag) { $tag = [string]$cfg.tag }

if ($Remove) {
  [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, 'dsh', $appId)
  Write-Output ('toast removed tag=' + $tag)
  exit 0
}

$toast = New-Object Windows.UI.Notifications.ToastNotification $template
$toast.Tag = $tag
$toast.Group = 'dsh'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
Write-Output ('toast shown as ' + $appId + ' tag=' + $tag)