"""Run an exported rosezm Python app against a stubbed Tkinter.

The exporter targets a machine that has Python but no display (CI), so the
strongest check available is: import the generated app, let it build its widget
tree through a recording Tk stub, invoke a real button handler, and print one
JSON line the suite asserts on. Real Python executes the real generated code -
only the widgets are fake.

Usage: python python-smoke.py <export-dir>
"""
import json
import os
import sys
import types

export_dir = os.path.abspath(sys.argv[1])
os.chdir(export_dir)
sys.path.insert(0, export_dir)


class Widget:
    """A recording stand-in for every Tk widget class."""
    instances = []
    scheduled = []

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        self.children = []
        self.packed = []
        Widget.instances.append(self)
        if args and hasattr(args[0], "children"):
            args[0].children.append(self)

    def pack(self, **kwargs):
        self.packed.append(kwargs)
        return self

    def grid(self, **kwargs):
        self.packed.append(kwargs)
        return self

    def tag_config(self, name, **kwargs):
        return self

    def insert(self, index, text, tags=()):
        # __getattr__ answers every missing name with a noop, so hasattr is
        # always true - the list must be forced into __dict__.
        self.__dict__.setdefault("inserted", []).append((text, tuple(tags)))
        return self

    def index(self, i):
        return "1.0"

    def config(self, **kwargs):
        return self

    def destroy(self):
        for child in list(self.children):
            child.destroy()
        self.children = []

    def winfo_children(self):
        return list(self.children)

    def configure(self, **kwargs):
        self.kwargs.update(kwargs)

    def title(self, *args):
        self._title = args[0] if args else ""

    def geometry(self, *args):
        pass

    def mainloop(self):
        pass

    def after(self, ms, callback=None):
        """Record a scheduled callback so a {#defer} arming can be counted.

        __getattr__ would answer this with a silent noop, which is exactly why
        a re-arm per render was invisible: every extra timer looked identical
        to the correct one. Recording them makes the storm countable.
        """
        Widget.scheduled.append((ms, callback))
        return len(Widget.scheduled)

    def __getattr__(self, name):
        def noop(*a, **k):
            return None
        return noop


class StringVar:
    def __init__(self, value=""):
        self._value = value

    def get(self):
        return self._value

    def set(self, value):
        self._value = value

    def trace_add(self, *args):
        return None


tk = types.ModuleType("tkinter")
for name in [
    "Tk", "Frame", "Label", "Button", "Entry", "Text", "OptionMenu", "LabelFrame",
    "Canvas", "Scrollbar", "Toplevel", "Checkbutton", "Listbox", "Menu", "PhotoImage",
]:
    setattr(tk, name, Widget)
tk.StringVar = StringVar
tk.IntVar = StringVar
# Tk's own constants: a page that writes into a Text widget says `tk.END`, and a
# layout that pins a side says `tk.LEFT`. They are plain strings in Tk, so the
# stub hands back the same ones - without them a real page fails to import here
# and passes on a machine that has a display.
for _const in [
    "END", "INSERT", "SEL_FIRST", "SEL_LAST", "NONE", "X", "Y", "BOTH",
    "LEFT", "RIGHT", "TOP", "BOTTOM", "N", "S", "E", "W", "CENTER",
    "NE", "NW", "SE", "SW", "NS", "EW", "NESW", "NWSE", "VERTICAL",
    "HORIZONTAL", "SUNKEN", "RAISED", "FLAT", "RIDGE", "GROOVE", "SOLID",
]:
    setattr(tk, _const, _const.lower())
sys.modules["tkinter"] = tk
ttk = types.ModuleType("tkinter.ttk")
for name in ["Frame", "Button", "Label", "Entry", "Scrollbar"]:
    setattr(ttk, name, Widget)
sys.modules["tkinter.ttk"] = ttk

calls = []
import rosezm  # noqa: E402  (after the stub is installed)

rosezm.data_patch = lambda route: calls.append(["data", route]) or {
    "post": {"title": "Smoke Post", "body": "from the data channel"},
    "count": 7,
    "likes": 41,
}
rosezm.action_patch = lambda route, name: calls.append(["action", route, name]) or {"likes": 99}

import app as app_module  # noqa: E402

result = {"ok": False}

try:
    application = app_module.RoseApp()
    application.show("/")
    labels = [str(w.kwargs.get("text", "")) for w in Widget.instances if w.kwargs.get("text")]
    text = " ".join(labels)
    result["labels"] = text[:500]
    result["pages"] = len(app_module.PAGES)
    result["home_labels"] = any("Increment" in label for label in labels)
    result["data_call"] = ["data", "/"] in calls

    # Drive a real handler: the Increment button's command mutates state and the
    # app re-renders through its own show()/render() path.
    before = text
    increment = None
    for widget in list(Widget.instances):
        command = widget.kwargs.get("command")
        if command is not None and "Increment" in str(widget.kwargs.get("text", "")):
            increment = command
            break
    if increment is None:
        result["error"] = "no Increment button found"
    else:
        state_before = dict(application.states.get("/", {}))
        increment()
        state_after = dict(application.states.get("/", {}))
        result["increment"] = [state_before.get("count"), state_after.get("count")]
        after_labels = [str(w.kwargs.get("text", "")) for w in Widget.instances if w.kwargs.get("text")]
        result["rerendered"] = " ".join(after_labels)[:500] != before

    # The Add Item button's handler reads the list length (items().length) and
    # appends a computed label. `.length` used to be refused here, so the button
    # was a no-op stub; it now compiles to len() and the JS string concat is
    # coerced (str()), so the handler runs instead of raising.
    add_item = None
    for widget in list(Widget.instances):
        command = widget.kwargs.get("command")
        if command is not None and "Add Item" in str(widget.kwargs.get("text", "")):
            add_item = command
            break
    if add_item is None:
        result["error"] = "no Add Item button found"
    else:
        items_before = list(application.states.get("/", {}).get("items", []))
        add_item()
        items_after = list(application.states.get("/", {}).get("items", []))
        # 3 seeds -> 4 items; the label is a coerced string ("Item 31", exactly
        # what the web build produces from 'Item ' + length + 1).
        result["add_item"] = [len(items_before), len(items_after), items_after[-1] if items_after else None]

    # A dynamic route resolves its params into the page state.
    application.show("/blog/1")
    params_state = application.states.get("/blog/:id", {})
    result["param"] = params_state.get("id")
    result["param_data_call"] = ["data", "/blog/1"] in calls

    # Navigation keeps a back-stack the way the web and a phone do. A link
    # follows with push=True, so showing the home page from /blog/1 remembers it
    # and back() returns. Back at the floor is a no-op, never an error.
    application.navigate("/")
    result["nav_current"] = application.current
    application.back()
    result["back_current"] = application.current
    result["back_param"] = application.states.get("/blog/:id", {}).get("id")
    # Return to the floor, then one more back must be a no-op (not an error).
    application.back()
    result["floor_before"] = application.current
    application.back()
    result["back_floor_noop"] = application.current == result["floor_before"]
    # Trusted markup renders as markup: the kit helper parses the inline
    # HTML subset into tagged spans instead of escaped text.
    import rosezm as kit_module
    rich_box = kit_module.rose_html_label(None, '<p>Hi <strong>there</strong> &amp; <a href="/x">link</a></p>')
    rich_parts = getattr(rich_box, "inserted", [])
    result["rich_text"] = any("there" in text for text, _ in rich_parts) and any("r_bold" in tags for _, tags in rich_parts)
    result["rich_link"] = any("r_link" in tags for _, tags in rich_parts)
    result["rich_entity"] = any("&" in text for text, _ in rich_parts)

    # A {#defer hold=50} block renders only after its timer fires - and that
    # timer is armed exactly ONCE. build() runs again on every re-render, so an
    # unconditional app.root.after() armed a fresh timer on each one, and every
    # callback re-renders, arming the next: a render storm at the hold interval,
    # forever. The __DEFER_ARMED set bounds it to one arming per page module.
    DEFERRED = "延迟渲染"
    Widget.scheduled.clear()
    application.show("/defer-demo")
    before_fire = [str(w.kwargs.get("text", "")) for w in Widget.instances]
    result["defer_hidden_before"] = not any(DEFERRED in t for t in before_fire)
    result["defer_arm_first"] = len(Widget.scheduled)
    # Three more re-renders of the same page: the arming must not repeat.
    application.render()
    application.render()
    application.render()
    result["defer_arm_after_rerenders"] = len(Widget.scheduled)
    defer_state = application.states.get("/defer-demo", {})
    result["defer_flag_before"] = defer_state.get("__defer0")
    # Fire the armed timer exactly as Tk would when the hold elapses.
    if Widget.scheduled and Widget.scheduled[0][1] is not None:
        Widget.scheduled[0][1]()
    after_fire = [str(w.kwargs.get("text", "")) for w in Widget.instances]
    result["defer_flag_after"] = application.states.get("/defer-demo", {}).get("__defer0")
    result["defer_shown_after"] = any(DEFERRED in t for t in after_fire)
    # The fired callback re-rendered once, which must NOT arm another timer.
    result["defer_arm_after_fire"] = len(Widget.scheduled)

    # R201/on the desktop the build pass IS the recompute pass. /deftest
    # carries a $derived (sq = n * n), an $effect that maintains mirror = n * 7
    # and an object class shorthand. Before R202 a bare read there raised
    # NameError inside rose_text - and rose_text catches every exception, so the
    # page printed "This section failed to render." instead of the value and the
    # export still looked fine. Assert the values, not the absence of a crash.
    Widget.instances.clear()
    application.show("/deftest")
    def_state = application.states.get("/deftest", {})
    result["deftest_load"] = [def_state.get("n"), def_state.get("sq"), def_state.get("mirror")]
    def_labels = [str(w.kwargs.get("text", "")) for w in Widget.instances if w.kwargs.get("text")]
    result["deftest_failed"] = any("failed to render" in t for t in def_labels)
    result["deftest_mirror_label"] = any(t == "14" for t in def_labels)
    bump = None
    for widget in list(Widget.instances):
        command = widget.kwargs.get("command")
        if command is not None and "bump" in str(widget.kwargs.get("text", "")):
            bump = command
            break
    if bump is None:
        result["error"] = "no bump button found on /deftest"
    else:
        bump()
        after = application.states.get("/deftest", {})
        result["deftest_bump"] = [after.get("n"), after.get("sq"), after.get("mirror")]

    result["ok"] = True
except Exception as err:  # a broken export must fail loudly, with the reason
    result["error"] = f"{type(err).__name__}: {err}"

print(json.dumps(result))
