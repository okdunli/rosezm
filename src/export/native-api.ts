/**
 * native-api.ts - one spelling for the device capabilities every target already
 * owns, so a `.rose` page stops being web-only the moment it asks for one.
 *
 * A page writes
 *
 *     const shot = await useNative('camera', { quality: 0.8 });
 *
 * and the wired emitters expand that call into their platform's own API. Before
 * this module the same three lines had to be written once per target, in that
 * target's language, inside that target's kit.
 *
 * The table is DATA, not a plugin system: a capability is a name, and a target
 * either implements it (through the helper its kit defines) or genuinely does
 * not. An unimplemented pair warns with the capability AND the target, and the
 * call becomes `null` - the export never silently emits nothing.
 *
 * What each capability resolves to, on every target:
 *   camera          -> a local image path/URI (string), or null when cancelled
 *   geolocation     -> { latitude, longitude }, or null
 *   clipboard-read  -> the clipboard text (stable: '' when empty)
 *   clipboard-write -> true once written
 *   share           -> true once the share sheet was shown
 */

/** The capabilities a `.rose` script may name. */
export type NativeCapability = 'camera' | 'geolocation' | 'clipboard-read' | 'clipboard-write' | 'share' | 'scan-code' | 'make-phone-call' | 'vibrate' | 'toast' | 'modal' | 'get-battery' | 'get-network-type' | 'get-system-info' | 'save-image';

export const NATIVE_CAPABILITIES: NativeCapability[] = ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'scan-code', 'make-phone-call', 'vibrate', 'toast', 'modal', 'get-battery', 'get-network-type', 'get-system-info', 'save-image'];

/** The export registry's target names. Duplicated as a plain union so this
 *  module does not import the registry, which imports every emitter. */
export type NativeTarget =
  | 'weapp' | 'qq' | 'alipay' | 'baidu' | 'toutiao'
  | 'flutter' | 'android' | 'arkts' | 'xcode' | 'electron'
  | 'python' | 'dotnet' | 'java' | 'cpp';

/** How one target answers `useNative`. */
export interface NativeTargetSupport {
  /** The kit function the rewritten call names. */
  helper: string;
  /** Capabilities this target implements. */
  capabilities: NativeCapability[];
  /** Package per capability, for the targets that need one. */
  dependencies?: Partial<Record<NativeCapability, string>>;
  /** The platform API each capability lands on - named in warnings and docs. */
  platform: Partial<Record<NativeCapability, string>>;
  /** Extra platform facts a target needs declared (manifest entries). */
  manifest?: Partial<Record<NativeCapability, string[]>>;
}

/**
 * WeChat/QQ/Alipay/Baidu/Toutiao share one helper name and differ only in the
 * platform object they reach for at runtime, so the kit picks whichever global
 * exists instead of the emitter baking a dialect in.
 *
 * `share` is a real gap on the whole family: a mini program shares only through
 * `<button open-type="share">` plus an onShareAppMessage handler, which is a
 * template construct, not a call a handler can make.
 */
const MINI_CAPS: NativeCapability[] = ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'scan-code', 'make-phone-call', 'vibrate', 'toast', 'modal', 'get-battery', 'get-network-type', 'get-system-info', 'save-image'];

export const NATIVE_TARGETS: Record<NativeTarget, NativeTargetSupport> = {
  weapp: {
    helper: '__rosezmNative',
    capabilities: MINI_CAPS,
    platform: {
      camera: 'wx.chooseMedia',
      geolocation: 'wx.getLocation',
      'clipboard-read': 'wx.getClipboardData',
      'clipboard-write': 'wx.setClipboardData',
      'scan-code': 'wx.scanCode',
      'make-phone-call': 'wx.makePhoneCall',
      'toast': 'wx.showToast',
      'modal': 'wx.showModal',
      'get-battery': 'wx.getBatteryInfo',
      'get-network-type': 'wx.getNetworkType',
      'get-system-info': 'wx.getSystemInfo',
      'save-image': 'wx.saveImageToPhotosAlbum',
      'vibrate': 'wx.vibrateLong',
    },
    manifest: { geolocation: ['scope.userLocation'] },
  },
  qq: {
    helper: '__rosezmNative',
    capabilities: MINI_CAPS,
    platform: {
      camera: 'qq.chooseMedia',
      geolocation: 'qq.getLocation',
      'clipboard-read': 'qq.getClipboardData',
      'clipboard-write': 'qq.setClipboardData',
      'scan-code': 'qq.scanCode',
      'make-phone-call': 'qq.makePhoneCall',
      'toast': 'qq.showToast',
      'modal': 'qq.showModal',
      'get-battery': 'qq.getBatteryInfo',
      'get-network-type': 'qq.getNetworkType',
      'get-system-info': 'qq.getSystemInfo',
      'save-image': 'qq.saveImageToPhotosAlbum',
      'vibrate': 'qq.vibrateLong',
    },
    manifest: { geolocation: ['scope.userLocation'] },
  },
  alipay: {
    helper: '__rosezmNative',
    capabilities: MINI_CAPS,
    platform: {
      camera: 'my.chooseImage',
      geolocation: 'my.getLocation',
      'clipboard-read': 'my.getClipboard',
      'clipboard-write': 'my.setClipboard',
      'scan-code': 'my.scan',
      'make-phone-call': 'my.makePhoneCall',
      'toast': 'my.showToast',
      'modal': 'my.confirm',
      'get-battery': 'my.getBatteryInfo',
      'get-network-type': 'my.getNetworkType',
      'get-system-info': 'my.getSystemInfo',
      'save-image': 'my.saveImageToPhotosAlbum',
    },
    manifest: { geolocation: ['location'] },
  },
  baidu: {
    helper: '__rosezmNative',
    capabilities: MINI_CAPS,
    platform: {
      camera: 'swan.chooseImage',
      geolocation: 'swan.getLocation',
      'clipboard-read': 'swan.getClipboardData',
      'clipboard-write': 'swan.setClipboardData',
      'scan-code': 'swan.scanCode',
      'make-phone-call': 'swan.makePhoneCall',
      'toast': 'swan.showToast',
      'modal': 'swan.showModal',
      'get-battery': 'swan.getBatteryInfo',
      'get-network-type': 'swan.getNetworkType',
      'get-system-info': 'swan.getSystemInfo',
      'save-image': 'swan.saveImageToPhotosAlbum',
      'vibrate': 'swan.vibrateLong',
    },
    manifest: { geolocation: ['scope.userLocation'] },
  },
  toutiao: {
    helper: '__rosezmNative',
    capabilities: MINI_CAPS,
    platform: {
      camera: 'tt.chooseImage',
      geolocation: 'tt.getLocation',
      'clipboard-read': 'tt.getClipboardData',
      'clipboard-write': 'tt.setClipboardData',
      'scan-code': 'tt.scanCode',
      'make-phone-call': 'tt.makePhoneCall',
      'toast': 'tt.showToast',
      'modal': 'tt.showModal',
      'get-battery': 'tt.getBatteryInfo',
      'get-network-type': 'tt.getNetworkType',
      'get-system-info': 'tt.getSystemInfo',
      'save-image': 'tt.saveImageToPhotosAlbum',
      'vibrate': 'tt.vibrateLong',
    },
    manifest: { geolocation: ['scope.userLocation'] },
  },
  flutter: {
    helper: 'roseNative',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'vibrate', 'scan-code', 'toast', 'modal', 'get-battery', 'get-network-type', 'get-system-info', 'save-image'],
    dependencies: { camera: 'image_picker', geolocation: 'geolocator', share: 'share_plus', 'make-phone-call': 'url_launcher', 'scan-code': 'mobile_scanner', 'get-battery': 'battery_plus', 'get-network-type': 'connectivity_plus', 'get-system-info': 'device_info_plus', 'save-image': 'gal' },
    platform: {
      camera: 'image_picker',
      geolocation: 'geolocator',
      'clipboard-read': 'Clipboard.getData',
      'clipboard-write': 'Clipboard.setData',
      share: 'share_plus',
      'make-phone-call': 'url_launcher tel:',
      vibrate: 'HapticFeedback.mediumImpact',
      'scan-code': 'mobile_scanner (a pushed scanner route)',
      'get-battery': 'battery_plus (a package)',
      'get-network-type': 'connectivity_plus (a package)',
      'get-system-info': 'device_info_plus (a package)',
      'save-image': 'gal (a package)',
      toast: 'SnackBar (no package)',
      modal: 'showDialog (no package)'
    },
  },
  arkts: {
    helper: 'roseNative',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'vibrate', 'scan-code', 'toast', 'modal', 'get-battery', 'get-network-type', 'get-system-info'],
    platform: {
      camera: '@ohos.multimedia.camera / photoAccessHelper',
      'get-battery': '@ohos.batteryInfo (sync property)',
      'get-network-type': '@ohos.telephony.data (sync)',
      'get-system-info': '@ohos.deviceInfo (sync property)',
      'save-image': 'photoAccessHelper (needs security component)',
      toast: 'promptAction.showToast (UIKit)',
      modal: 'promptAction.showDialog (UIKit)',
      'scan-code': 'scanBarcode.launchScanner (ScanKit)',
      geolocation: '@ohos.geoLocationManager',
      'clipboard-read': '@ohos.pasteboard',
      'clipboard-write': '@ohos.pasteboard',
      share: '@ohos.app.ability.wantAgent',
      'make-phone-call': 'call.makeCall (TelephonyKit)',
      vibrate: '@ohos.vibrator (VibratePreset)'
    },
    manifest: {
      camera: ['ohos.permission.CAMERA'],
      geolocation: ['ohos.permission.LOCATION', 'ohos.permission.APPROXIMATELY_LOCATION'],
      vibrate: ['ohos.permission.VIBRATE'],
    },
  },
  android: {
    helper: 'roseNative',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'vibrate', 'toast', 'modal', 'scan-code', 'get-battery', 'get-network-type', 'get-system-info', 'save-image'],
    platform: {
      camera: 'ActivityResultContracts.TakePicture',
      toast: 'Toast.makeText',
      modal: 'AlertDialog (needs an Activity Context)',
      geolocation: 'FusedLocationProviderClient',
      'clipboard-read': 'ClipboardManager',
      'clipboard-write': 'ClipboardManager',
      share: 'Intent.ACTION_SEND',
      'make-phone-call': 'Intent.ACTION_DIAL',
      'get-battery': 'BatteryManager sticky intent (sync)',
      'get-network-type': 'ConnectivityManager (sync)',
      'get-system-info': 'Build (sync)',
      'save-image': 'MediaStore (API 29+, no permission)',
      vibrate: 'Vibrator (VibratorManager)',
      'scan-code': 'ML Kit Barcode Scanning (the RoseApp scan bridge)',
    },
    // A permission is not optional decoration: without CAMERA the contract
    // fails on a real device, and without a location permission the fused
    // provider throws SecurityException into the caller's lap.
    manifest: {
      camera: ['android.permission.CAMERA'],
      geolocation: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
    },
  },
  xcode: {
    helper: 'roseNative',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'vibrate', 'scan-code', 'toast', 'modal', 'get-battery', 'get-system-info', 'save-image'],
    platform: {
      camera: 'UIImagePickerController',
      toast: 'no first-party toast (a label overlay works)',
      modal: 'UIAlertController (the RoseKit modal bridge)',
      geolocation: 'CLLocationManager',
      'clipboard-read': 'UIPasteboard',
      'clipboard-write': 'UIPasteboard',
      share: 'UIActivityViewController',
      'make-phone-call': 'UIApplication.open(tel:)',
      'get-battery': 'UIDevice.batteryLevel (needs monitoring enabled)',
      'get-network-type': 'NWPathMonitor (async, no first-party sync)',
      'get-system-info': 'UIDevice + ProcessInfo (sync)',
      'save-image': 'UIImageWriteToSavedPhotosAlbum (photo-add usage)',
      vibrate: 'UIImpactFeedbackGenerator',
      'scan-code': 'DataScannerViewController (pushed as a full-screen cover)',
    },
    // Info.plist usage descriptions, named by KEY: iOS does not deny the
    // request without one, it terminates the process - the app crashes the
    // first time the capability is used.
    manifest: {
      camera: ['NSCameraUsageDescription'],
      geolocation: ['NSLocationWhenInUseUsageDescription'],
      'save-image': ['NSPhotoLibraryAddUsageDescription'],
    },
  },
  // Wired through the preload bridge: the electron export ships the framework's
  // real web bundle untouched, so `useNative(...)` stays a bare call there and
  // preload.cjs exposes it as the one global the bundle resolves - browser APIs
  // on the other side of contextIsolation.
  electron: {
    helper: 'useNative',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'vibrate', 'scan-code', 'make-phone-call'],
    platform: {
      camera: 'navigator.mediaDevices.getUserMedia',
      geolocation: 'navigator.geolocation',
      'clipboard-read': 'navigator.clipboard.readText',
      'clipboard-write': 'navigator.clipboard.writeText',
      share: 'navigator.share',
      vibrate: 'navigator.vibrate',
      'make-phone-call': 'ipcRenderer.invoke + shell.openExternal(tel:)',
      toast: 'a DOM toast element (no native chrome needed)',
      modal: 'a DOM modal dialog (no native chrome needed)',
    },
  },
  // Wired through the kit: the emitted rosezm.py defines rose_native(...) with
  // one branch per capability this project asked for, and every handler body
  // expands its useNative call to it.
  python: {
    helper: 'rose_native',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'toast', 'modal'],
    platform: {
      camera: 'tkinter.filedialog',
      toast: 'tkinter message label / Toplevel (a window, the Tk way)',
      modal: 'tkinter.messagebox (stdlib)',
      geolocation: 'no Tk API (an app needs an OS/web location service)',
      'clipboard-read': 'tkinter.clipboard_get',
      'clipboard-write': 'tkinter.clipboard_append',
      share: 'webbrowser.open',
      'make-phone-call': 'webbrowser.open(tel:)',
    },
  },
  dotnet: {
    helper: 'RoseKit.RoseNative',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'modal'],
    platform: {
      camera: 'OpenFileDialog',
      toast: 'a WPF overlay (no system toast)',
      modal: 'MessageBox.Show',
      geolocation: 'GeoCoordinateWatcher (a package - not in the box for net8.0)',
      'clipboard-read': 'Clipboard.GetText',
      'clipboard-write': 'Clipboard.SetText',
      share: 'Process.Start',
      'make-phone-call': 'Process.Start(tel:)',
    },
  },
  java: {
    helper: 'RoseKit.roseNative',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'modal'],
    platform: {
      camera: 'no capture API (java.awt.Robot / third-party webcam lib)',
      toast: 'a Swing overlay (no system toast)',
      modal: 'JOptionPane (stdlib)',
      geolocation: 'no JDK API (third-party library)',
      'clipboard-read': 'Toolkit.getSystemClipboard',
      'clipboard-write': 'Toolkit.getSystemClipboard',
      share: 'Desktop.browse',
      'make-phone-call': 'Desktop.browse(tel:)',
    },
  },
  // Wired through the kit: rose.h declares rose_native(...), rose.cpp defines
  // it (Qt's own corners of the toolkit), and every handler body expands its
  // useNative call to it.
  cpp: {
    helper: 'rose_native',
    capabilities: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'make-phone-call', 'modal'],
    platform: {
      camera: 'QFileDialog',
      toast: 'a QLabel overlay (no system toast)',
      modal: 'QMessageBox (Qt)',
      geolocation: 'QGeoPositionInfoSource',
      'clipboard-read': 'QClipboard',
      'clipboard-write': 'QClipboard',
      share: 'QDesktopServices::openUrl',
      'make-phone-call': 'QDesktopServices::openUrl(tel:)',
    },
  },
};

/** A target's display name, for warnings a developer reads. */
const TARGET_NAMES: Record<NativeTarget, string> = {
  weapp: 'WeChat', qq: 'QQ', alipay: 'Alipay', baidu: 'Baidu', toutiao: 'Douyin',
  flutter: 'Flutter', android: 'Android', arkts: 'HarmonyOS ArkTS', xcode: 'Xcode/SwiftUI',
  electron: 'Electron', python: 'Python/Tkinter', dotnet: '.NET/WPF', java: 'Java/Swing', cpp: 'C++/Qt',
};

export function describeTarget(target: NativeTarget): string {
  return TARGET_NAMES[target];
}

/** The capabilities a project's scripts ask for, in convention order. */
export function nativeUsage(scripts: Array<string | null | undefined>): NativeCapability[] {
  const seen = new Set<string>();
  for (const script of scripts) {
    if (!script || !script.includes('useNative')) continue;
    for (const m of script.matchAll(/(^|[^\w$.])useNative\s*\(\s*(['"])([^'"]*)\2/g)) seen.add(m[3]);
  }
  return NATIVE_CAPABILITIES.filter((c) => seen.has(c));
}

/** The packages this target needs for the capabilities a project used. */
export function nativeDependencies(target: NativeTarget, used: Iterable<NativeCapability>): string[] {
  const deps = NATIVE_TARGETS[target].dependencies ?? {};
  const out: string[] = [];
  for (const cap of used) {
    const dep = deps[cap];
    if (dep && !out.includes(dep)) out.push(dep);
  }
  return out;
}

/** The manifest entries (permission scopes) a used capability needs declared. */
export function nativeManifestEntries(target: NativeTarget, used: Iterable<NativeCapability>): string[] {
  const entries = NATIVE_TARGETS[target].manifest ?? {};
  const out: string[] = [];
  for (const cap of used) {
    for (const entry of entries[cap] ?? []) if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * `{ quality: 0.8 }` -> the target's object-literal spelling. Only a flat
 * literal is accepted: anything else (a variable, a spread, a nested object)
 * returns null and the caller falls back to the platform defaults rather than
 * emitting an expression the target cannot parse.
 *
 * `keys` is `quoted` for Dart/ArkTS (`{ 'quality': 0.8 }`) and `bare` for the
 * mini-program's JS.
 */
export function literalOptions(raw: string, keys: 'quoted' | 'bare'): string | null {
  const text = (raw ?? '').trim();
  if (!text) return '{}';
  const body = text.match(/^\{([\s\S]*)\}$/);
  if (!body) return null;
  const pairs: string[] = [];
  for (const part of body[1].split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const kv = piece.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
    if (!kv) return null;
    const key = keys === 'quoted' ? `'${kv[1]}'` : kv[1];
    pairs.push(`${key}: ${kv[2].trim()}`);
  }
  return pairs.length ? `{ ${pairs.join(', ')} }` : '{}';
}

/** The `)` matching the `(` at `open`, or -1. Quotes are skipped so a paren
 *  inside an option string does not unbalance the scan. */function matchParen(src: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface RewriteResult {
  code: string;
  /** Capabilities this project actually exercises on this target. */
  used: NativeCapability[];
}

export interface RewriteOptions {
  target: NativeTarget;
  /** Spell the options literal in the target's syntax. `null` means the literal
   *  was not flat and the platform defaults are used instead. */
  options: (raw: string) => string | null;
  /** What a call with no equivalent becomes (`null`, `null`, `nil`...). */
  empty: string;
  warn: (message: string) => void;
  /** Optional file name for the warning text. */
  file?: string;
}

/**
 * Expand every `useNative('capability', options)` in `code` into the target's
 * call. A call this target cannot honour warns with the capability and the
 * target, and becomes `empty` so the code around it still runs and still
 * compiles.
 */
export function rewriteNativeCalls(code: string, opts: RewriteOptions): RewriteResult {
  if (!code || !code.includes('useNative')) return { code, used: [] };
  const support = NATIVE_TARGETS[opts.target];
  const name = describeTarget(opts.target);
  const where = opts.file ? `${opts.file}: ` : '';
  const used = new Set<NativeCapability>();
  let out = '';
  let i = 0;
  for (;;) {
    const at = code.indexOf('useNative', i);
    if (at < 0) { out += code.slice(i); break; }
    // A property read (`x.useNative`, `my_useNative`) is not the convention.
    if (/[A-Za-z0-9_$.]/.test(code[at - 1] ?? '')) { out += code.slice(i, at + 9); i = at + 9; continue; }
    let p = at + 9;
    while (p < code.length && /\s/.test(code[p])) p++;
    if (code[p] !== '(') { out += code.slice(i, at + 9); i = at + 9; continue; }
    const close = matchParen(code, p);
    if (close < 0) { out += code.slice(i, at + 9); i = at + 9; continue; }
    const args = code.slice(p + 1, close).trim();
    const head = args.match(/^(['"])([^'"]*)\1/);
    const capability = head ? head[2] : '';

    out += code.slice(i, at);
    if (!head || !(NATIVE_CAPABILITIES as string[]).includes(capability)) {
      opts.warn(`${where}useNative('${capability || '…'}') is not a known capability - ${name} emits ${opts.empty}`);
      out += opts.empty;
    } else if (!support.capabilities.includes(capability as NativeCapability)) {
      const api = support.platform[capability as NativeCapability];
      opts.warn(`${where}useNative('${capability}') has no ${name} equivalent${api ? ` (nearest platform API: ${api})` : ''} - emits ${opts.empty}`);
      out += opts.empty;
    } else {
      const cap = capability as NativeCapability;
      used.add(cap);
      const raw = args.slice(head[0].length).replace(/^\s*,\s*/, '');
      const spelled = opts.options(raw);
      // A non-literal options argument is not dropped in silence: the call still
      // fires with platform defaults, and the export says what was ignored.
      if (spelled === null) {
        opts.warn(`${where}useNative('${cap}') options ${raw.trim().slice(0, 40)} are not a flat object literal - ${name} uses the platform defaults`);
      }
      out += `${support.helper}('${cap}', ${spelled ?? '{}'})`;
    }
    i = close + 1;
  }
  return { code: out, used: [...used] };
}
