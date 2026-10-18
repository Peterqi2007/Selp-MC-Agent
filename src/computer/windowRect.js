'use strict';

/**
 * Read-only window geometry for computer use (P1 M5 / F1).
 *
 * F1 needs `bounds` before `WindowPolicy.verify()` may pass, and those bounds must be a real
 * position - not a guess. Two sources, in order:
 *
 *   1. `helper` - whatever the DSH / computer-use bridge can report for the window;
 *   2. `win32`  - a read-only Win32/DWM query: `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`
 *                 with `GetWindowRect` as fallback. Enumeration is `Get-Process` +
 *                 `MainWindowHandle`; nothing is drawn, captured or injected.
 *
 * **Screenshot pixel size is never a rect.** It has a width and a height but no x/y, so treating
 * it as bounds would mean inventing the window origin. `screenshot-size` is therefore not an
 * accepted source and `normalizeRect()` refuses it outright.
 *
 * The Win32 provider needs a runner that can capture a child process's stdout. Under a sandbox
 * that forbids piped stdio the runner throws, `resolveRect()` records `provider-error` and the
 * caller gets `rect-unavailable` - it must then report "bounds 待补", not invent coordinates.
 */

const { RECT_SOURCES } = require('./windowPolicy');

/**
 * Validate a rect that some provider reported.
 * @returns {{ok:boolean, reason?:string, rect?:{x:number,y:number,width:number,height:number,source:string}}}
 */
function normalizeRect(value, fallbackSource) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'rect-required' };
  const source = value.source || fallbackSource;
  if (!RECT_SOURCES.includes(source)) return { ok: false, reason: 'rect-source-invalid' };
  const { x, y, width, height } = value;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return { ok: false, reason: 'rect-invalid' };
  if (!(width > 0) || !(height > 0)) return { ok: false, reason: 'rect-invalid' };
  return {
    ok: true,
    rect: { x, y, width, height, source, hwnd: value.hwnd || null, windowId: value.windowId || null }
  };
}

/**
 * Ask each provider in order; the first valid rect wins. Never fabricates a rect.
 * @param {object} input { providers, windowId }
 */
async function resolveRect({ providers = [], windowId } = {}) {
  const attempts = [];
  for (const provider of providers) {
    const name = (provider && provider.name) || 'unknown';
    if (!provider || typeof provider.get !== 'function') {
      attempts.push({ provider: name, ok: false, reason: 'provider-invalid' });
      continue;
    }
    try {
      const value = await provider.get(windowId);
      const normalized = normalizeRect(value, provider.name);
      if (!normalized.ok) {
        attempts.push({ provider: name, ok: false, reason: normalized.reason });
        continue;
      }
      attempts.push({ provider: name, ok: true, reason: 'rect-resolved' });
      return { ok: true, rect: normalized.rect, attempts };
    } catch (err) {
      attempts.push({ provider: name, ok: false, reason: 'provider-error', error: err.message });
    }
  }
  return { ok: false, reason: 'rect-unavailable', attempts };
}

/** Wrap a host-provided rect getter (the DSH/helper bridge) as a provider. */
function helperRectProvider(getRect) {
  return {
    name: 'helper',
    async get(windowId) {
      const rect = await getRect(windowId);
      if (!rect) throw new Error('helper returned no rect');
      return { ...rect, source: 'helper', windowId };
    }
  };
}

/** Build the read-only PowerShell probe. No GDI drawing, no capture, no input. */
function buildWin32Script({ processName = 'java', titlePattern = '*Minecraft*' } = {}) {
  const proc = JSON.stringify(processName);
  const title = JSON.stringify(titlePattern);
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    'public class CuRectWin {',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);',
    '}',
    "'@",
    `$p = Get-Process -Name ${proc} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like ${title} } | Select-Object -First 1`,
    'if (-not $p) { Write-Output \'{"ok":false,"reason":"window-not-found"}\'; exit 0 }',
    '$hwnd = $p.MainWindowHandle',
    'if ($hwnd -eq 0) { Write-Output \'{"ok":false,"reason":"no-main-window"}\'; exit 0 }',
    'if ([CuRectWin]::IsIconic($hwnd)) { Write-Output \'{"ok":false,"reason":"window-minimized"}\'; exit 0 }',
    '$r = New-Object RECT',
    "$source = 'dwm'",
    '$hr = [CuRectWin]::DwmGetWindowAttribute($hwnd, 9, [ref]$r, 16)',
    "if ($hr -ne 0) { $source = 'win32'; [void][CuRectWin]::GetWindowRect($hwnd, [ref]$r) }",
    '$w = $r.Right - $r.Left',
    '$h = $r.Bottom - $r.Top',
    'if ($w -le 0 -or $h -le 0) { Write-Output \'{"ok":false,"reason":"rect-invalid"}\'; exit 0 }',
    '$out = @{ ok = $true; pid = $p.Id; rect = @{ x = $r.Left; y = $r.Top; width = $w; height = $h; source = $source; hwnd = [int64]$hwnd } } | ConvertTo-Json -Compress -Depth 5',
    'Write-Output $out'
  ].join('\n');
}

/**
 * Default runner: read-only PowerShell probe. Kept injectable so tests never touch the OS.
 * @param {string} script
 */
function defaultWin32Runner(script, { timeout = 8000 } = {}) {
  const { execFileSync } = require('child_process');
  const shells = ['pwsh', 'powershell'];
  let lastError = null;
  for (const shell of shells) {
    try {
      return execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout,
        windowsHide: true
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`no powershell runner available: ${lastError && lastError.message}`);
}

/**
 * Read-only Win32/DWM rect provider.
 * @param {object} options { runner, processName, titlePattern }
 */
function win32RectProvider(options = {}) {
  const runner = options.runner || defaultWin32Runner;
  const processName = options.processName || 'java';
  const titlePattern = options.titlePattern || '*Minecraft*';
  return {
    name: 'win32',
    async get(windowId) {
      const script = buildWin32Script({ processName, titlePattern });
      const output = await runner(script, { windowId });
      let parsed;
      try {
        parsed = JSON.parse(String(output || '').trim());
      } catch (err) {
        throw new Error('unparsable rect output');
      }
      if (!parsed || parsed.ok !== true) {
        throw new Error((parsed && parsed.reason) || 'rect query failed');
      }
      return { ...parsed.rect, windowId, pid: parsed.pid };
    }
  };
}

module.exports = {
  normalizeRect,
  resolveRect,
  helperRectProvider,
  win32RectProvider,
  buildWin32Script,
  defaultWin32Runner
};
