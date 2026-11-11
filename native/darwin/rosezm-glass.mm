// rosezm - native Liquid Glass controls for Electron (macOS).
// N-API addon: a system NSToolbar (UnifiedCompact, hidden title) hosts the
// three buttons. The SYSTEM owns Liquid Glass sizing, the press/hold
// animation, and window-resize layout for toolbar items on macOS 26 -
// hand-placed NSGlassEffectView frames get none of that (and a delegate that
// isn't retained dies at the end of install(), which is why clicks were dead).
// Items: [sidebar toggle] [back | forward]
// Clicks leave through one N-API callback: { action }.
#include <node_api.h>
#import <AppKit/AppKit.h>
#include <cstring>

static napi_env g_env = nullptr;
static napi_ref g_cb = nullptr;
@class RoseToolbarDelegate;
static RoseToolbarDelegate *g_delegate = nil; // NSToolbar.delegate is weak

static NSImage *RoseImage(NSString *name, NSString *fallback) {
  NSImage *img = [NSImage imageNamed:name];
  return img ?: [NSImage imageNamed:fallback];
}

// Retained for the process lifetime: NSToolbar holds its delegate weakly,
// so a local dies before the first click and the action becomes nil.
@interface RoseToolbarDelegate : NSObject <NSToolbarDelegate>
@end
@implementation RoseToolbarDelegate
- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar {
  return @[ @"rosezm.sidebar", @"rosezm.nav" ];
}
- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar {
  return @[ @"rosezm.sidebar", @"rosezm.nav" ];
}
- (nullable NSToolbarItem *)toolbar:(NSToolbar *)toolbar
              itemForItemIdentifier:(NSToolbarItemIdentifier)identifier
          willBeInsertedIntoToolbar:(BOOL)flag {
  NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:identifier];
  NSSegmentedControl *seg = [[NSSegmentedControl alloc] initWithFrame:NSZeroRect];
  seg.segmentStyle = NSSegmentStyleTexturedRounded;
  seg.trackingMode = NSSegmentSwitchTrackingMomentary;
  if ([identifier isEqualToString:@"rosezm.sidebar"]) {
    seg.segmentCount = 1;
    [seg setImage:RoseImage(@"NSSidebarTemplate", NSImageNameGoLeftTemplate) forSegment:0];
    seg.tag = 1;
  } else {
    seg.segmentCount = 2;
    [seg setImage:RoseImage(@"NSGoLeftTemplate", NSImageNameGoLeftTemplate) forSegment:0];
    [seg setImage:RoseImage(@"NSGoRightTemplate", NSImageNameGoRightTemplate) forSegment:1];
    seg.tag = 2;
  }
  seg.target = self;
  seg.action = @selector(clicked:);
  [seg sizeToFit];
  item.view = seg;
  return item;
}
- (void)clicked:(NSSegmentedControl *)sender {
  if (!g_env || !g_cb) return;
  napi_value undefined, cb, arg, action;
  napi_get_undefined(g_env, &undefined);
  napi_get_reference_value(g_env, g_cb, &cb);
  const char *a = sender.tag == 1 ? "toggle" : (sender.selectedSegment == 0 ? "back" : "forward");
  napi_create_object(g_env, &arg);
  napi_create_string_utf8(g_env, a, NAPI_AUTO_LENGTH, &action);
  napi_set_named_property(g_env, arg, "action", action);
  napi_call_function(g_env, undefined, cb, 1, &arg, nullptr);
}
@end

static NSView *ViewFromHandle(napi_env env, napi_value handle) {
  void *data = nullptr; size_t len = 0;
  if (napi_get_buffer_info(env, handle, &data, &len) != napi_ok || len < sizeof(void*)) return nil;
  void *ptr = nullptr; std::memcpy(&ptr, data, sizeof(void*));
  return (__bridge NSView *)ptr;
}

static napi_value Install(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  NSView *content = ViewFromHandle(env, args[0]);
  if (!content || !content.window) { napi_value f; napi_get_boolean(env, false, &f); return f; }
  if (content.window.toolbar != nil) { napi_value t; napi_get_boolean(env, true, &t); return t; }

  if (argc > 0) { /* callback comes second */ }
  size_t cbArgc = 2; napi_value cbArgs[2];
  napi_get_cb_info(env, info, &cbArgc, cbArgs, nullptr, nullptr);
  napi_ref cbRef = nullptr;
  if (cbArgc > 1) napi_create_reference(env, cbArgs[1], 1, &cbRef);
  g_env = env; g_cb = cbRef;

  if (@available(macOS 26.0, *)) {
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"rosezm.glass.toolbar"];
    g_delegate = [RoseToolbarDelegate new];       // process-lifetime retention
    toolbar.delegate = g_delegate;
    toolbar.displayMode = NSToolbarDisplayModeIconOnly;
    toolbar.allowsUserCustomization = NO;
    content.window.toolbar = toolbar;
    content.window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
    content.window.titleVisibility = NSWindowTitleHidden;
    napi_value ok; napi_get_boolean(env, true, &ok);
    return ok;
  }

  napi_value f; napi_get_boolean(env, false, &f);
  return f;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, Install, nullptr, &fn);
  napi_set_named_property(env, exports, "install", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
