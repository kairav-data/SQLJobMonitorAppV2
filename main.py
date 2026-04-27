"""
main.py — pywebview entry point for SQL Job Monitor.
Replaces CustomTkinter with a native window hosting the HTML/CSS/JS UI.
"""
import webview
import sys
import os
from api import Api


def resource_path(relative):
    """Resolve path — works both in dev and as a PyInstaller bundle."""
    if hasattr(sys, "_MEIPASS"):
        base = sys._MEIPASS
    else:
        base = os.path.abspath(os.path.dirname(__file__))
    return os.path.join(base, relative)


def file_url(relative):
    """Return a file:// URL for the given relative path (needed by pywebview in frozen apps)."""
    abs_path = resource_path(relative)
    # Normalise to forward slashes and prepend file:///
    return "file:///" + abs_path.replace("\\", "/")


if __name__ == "__main__":
    api = Api()
    window = webview.create_window(
        title="SQL Job Monitor",
        url=file_url("web/index.html"),
        js_api=api,
        width=1340,
        height=820,
        min_size=(1040, 620),
        frameless=False,
        easy_drag=False,
    )
    webview.start(debug=False, private_mode=True)
