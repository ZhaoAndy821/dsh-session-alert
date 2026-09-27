<#
  present.ps1 - DSH desktop alert card (native topmost popup).

  Shows one borderless, always-on-top card in the bottom-right corner of the
  primary screen work area, above every other window, without stealing focus.
  Click -> tell the bridge to open that session in the DSH web UI; if no page is
  connected, open the fallback URL in the default browser. The card also tries to
  bring the browser window that hosts the DSH UI to the foreground.

  This file is deliberately ASCII-only: every localized string arrives through
  the -Payload JSON file (UTF-8). PowerShell 5.1 reads BOM-less files as ANSI, so
  non-ASCII source text would be corrupted.

  Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File present.ps1 -Payload <file.json> [-Slot 0]
#>
param(
  [Parameter(Mandatory = $true)][string]$Payload,
  [int]$Slot = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml

$cfg = [System.IO.File]::ReadAllText($Payload, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

$debugPath = $env:DSH_ALERT_DEBUG
function Dbg([string]$message) {
  if (-not $debugPath) { return }
  try { [System.IO.File]::AppendAllText($debugPath, ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $message + "`r`n"), [System.Text.Encoding]::UTF8) } catch { }
}
Dbg 'parsed payload'

function Esc([object]$value) {
  if ($null -eq $value) { return '' }
  $s = [string]$value
  $s = $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
  return $s
}

$light = ($cfg.theme -eq 'light')
if ($light) {
  $bg = '#F7FFFFFF'; $fg = '#FF1F2329'; $sub = '#FF5A6472'; $hintFg = '#FF98A0AC'
  $border = '#1F000000'; $closeFg = '#FF98A0AC'; $shadow = '#40000000'
} else {
  $bg = '#F41C1F27'; $fg = '#FFF2F4F8'; $sub = '#FFA3ACBA'; $hintFg = '#FF7A8493'
  $border = '#26FFFFFF'; $closeFg = '#FF7A8493'; $shadow = '#66000000'
}

$glyph = if ($cfg.glyph) { [string]$cfg.glyph } else { [char]0x2713 }
$accent = if ($cfg.accent) { [string]$cfg.accent } else { '#FF22C55E' }
$hint = if ($cfg.hint) { [string]$cfg.hint } else { 'Click to open' }
$title = [string]$cfg.title
$body = [string]$cfg.body
$durationMs = 9000
if ($cfg.durationMs) { $durationMs = [int]$cfg.durationMs }
# Windows toasts occupy the same corner; when both surfaces are used the caller
# asks the card to sit above them instead of behind them.
$topOffset = 0
if ($cfg.yOffset) { $topOffset = [int]$cfg.yOffset }
$font = 'Segoe UI, Microsoft YaHei UI, Malgun Gothic'

$bodyBlock = ''
if ($body -ne '') {
  $bodyBlock = '<TextBlock Text="' + (Esc $body) + '" FontSize="12.5" Foreground="' + $sub + '" TextWrapping="Wrap" MaxHeight="36" Margin="0,3,0,0"/>'
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ShowActivated="False"
        ResizeMode="NoResize" SizeToContent="Height" Width="392" Opacity="0"
        FontFamily="__FONT__" TextOptions.TextFormattingMode="Display">
  <Border x:Name="Root" CornerRadius="14" Background="__BG__" BorderBrush="__BORDER__" BorderThickness="1" Margin="10,10,14,14" RenderTransformOrigin="0.5,0.5">
    <Border.RenderTransform><TranslateTransform x:Name="Slide" X="26"/></Border.RenderTransform>
    <Border.Effect><DropShadowEffect BlurRadius="22" ShadowDepth="3" Direction="270" Opacity="0.5" Color="__SHADOW__"/></Border.Effect>
    <Grid Margin="15,13,12,13">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="Auto"/>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <Border Grid.Column="0" Width="34" Height="34" CornerRadius="17" Background="__ACCENT__" VerticalAlignment="Top">
        <TextBlock Text="__GLYPH__" FontSize="17" Foreground="#FFFFFFFF" HorizontalAlignment="Center" VerticalAlignment="Center"/>
      </Border>
      <StackPanel Grid.Column="1" Margin="12,0,10,0" VerticalAlignment="Center">
        <TextBlock Text="__TITLE__" FontSize="14" FontWeight="SemiBold" Foreground="__FG__" TextTrimming="CharacterEllipsis"/>
        __BODY__
        <TextBlock Text="__HINT__" FontSize="11" Foreground="__HINTFG__" Margin="0,6,0,0" TextTrimming="CharacterEllipsis"/>
      </StackPanel>
      <Button x:Name="Close" Grid.Column="2" Content="&#x2715;" FontSize="11" Width="22" Height="22" VerticalAlignment="Top"
              Foreground="__CLOSEFG__" Background="Transparent" BorderThickness="0" Cursor="Hand" ToolTip="Close"/>
    </Grid>
  </Border>
</Window>
'@

$xaml = $xaml.Replace('__FONT__', $font).Replace('__BG__', $bg).Replace('__BORDER__', $border).Replace('__SHADOW__', $shadow)
$xaml = $xaml.Replace('__ACCENT__', $accent).Replace('__GLYPH__', (Esc $glyph)).Replace('__TITLE__', (Esc $title))
$xaml = $xaml.Replace('__BODY__', $bodyBlock).Replace('__HINT__', (Esc $hint)).Replace('__HINTFG__', $hintFg)
$xaml = $xaml.Replace('__FG__', $fg).Replace('__CLOSEFG__', $closeFg)

Dbg 'building xaml'
$window = [Windows.Markup.XamlReader]::Parse($xaml)
Dbg 'xaml parsed'
$root = $window.FindName('Root')
$slide = $window.FindName('Slide')
$closeButton = $window.FindName('Close')

# Foreground hand-off: the card is the foreground window when clicked, so it is
# allowed to promote the browser window that hosts the DSH UI.
$signature = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DshWindow {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
  public static IntPtr Find(string needle) {
    if (string.IsNullOrEmpty(needle)) return IntPtr.Zero;
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.Length > 0 && sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Promote(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    try { AllowSetForegroundWindow(-1); } catch {}
    if (IsIconic(h)) ShowWindow(h, 9);
    else ShowWindow(h, 5);
    return SetForegroundWindow(h);
  }
}
'@
try { Add-Type -TypeDefinition $signature -ErrorAction Stop } catch { }

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds($durationMs)

$closeWindow = {
  try { $timer.Stop() } catch { }
  $out = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(160))))
  $out.Add_Completed({ try { $window.Close() } catch { } })
  $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $out)
}

$timer.Add_Tick({ & $closeWindow })

$openSession = {
  $sid = [string]$cfg.sessionId
  $opened = $false
  if ($sid -ne '' -and $cfg.bridgeUrl) {
    try {
      $payload = @{ sessionId = $sid; slot = $Slot } | ConvertTo-Json -Compress
      $response = Invoke-RestMethod -Uri ([string]$cfg.bridgeUrl + '/click') -Method Post -Body $payload -ContentType 'application/json' -TimeoutSec 3
      $opened = [bool]$response.opened
    } catch { $opened = $false }
  }
  # Prefer promoting the browser window that already hosts the DSH UI: a shell
  # open would spawn a second window instead of jumping in the open one.
  $needle = [string]$cfg.windowTitle
  $target = [IntPtr]::Zero
  if ($needle -ne '') { try { $target = [DshWindow]::Find($needle) } catch { $target = [IntPtr]::Zero } }
  if ($target -ne [IntPtr]::Zero) {
    try { [void][DshWindow]::Promote($target) } catch { }
  } elseif (-not $opened -and $cfg.url) {
    try { Start-Process ([string]$cfg.url) | Out-Null } catch { }
  }
}

$root.Add_MouseLeftButtonUp([System.Windows.Input.MouseButtonEventHandler]{
  param($sender, $eventArgs)
  & $openSession
  & $closeWindow
})

$root.Add_MouseEnter([System.Windows.Input.MouseEventHandler]{ param($sender, $eventArgs) $timer.Stop() })
$root.Add_MouseLeave([System.Windows.Input.MouseEventHandler]{ param($sender, $eventArgs) $timer.Start() })
$closeButton.Add_Click([System.Windows.RoutedEventHandler]{ param($sender, $eventArgs) & $closeWindow })

Dbg 'wiring'
$window.Add_ContentRendered({
  Dbg ('content rendered actual=' + $window.ActualHeight)
  $height = $window.ActualHeight
  $area = [System.Windows.SystemParameters]::WorkArea
  $window.Left = $area.Right - $window.Width - 6
  $window.Top = $area.Bottom - $height - 8 - $topOffset - ($Slot * ($height + 2))
  if ($window.Top -lt $area.Top) { $window.Top = $area.Top + 8 }
  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(0, 1, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(200))))
  $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
  $move = New-Object System.Windows.Media.Animation.DoubleAnimation(26, 0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(240))))
  $move.EasingFunction = (New-Object System.Windows.Media.Animation.CubicEase)
  $slide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $move)
  $timer.Start()
})

Dbg 'showdialog enter'
[void]$window.ShowDialog()
Dbg 'showdialog exit'
