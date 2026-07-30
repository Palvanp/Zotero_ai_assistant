import { config } from "../../package.json";

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window };
  } else {
    addon.data.prefs.window = _window;
  }
  bindPrefEvents();
}

function bindPrefEvents() {
  const doc = addon.data.prefs!.window.document;

  doc
    ?.querySelector(`#zotero-prefpane-${config.addonRef}-test-key`)
    ?.addEventListener("command", async () => {
      const statusLabel = doc?.querySelector(
        `#zotero-prefpane-${config.addonRef}-test-status`,
      );
      const apiKey = Zotero.Prefs.get(
        `${config.prefsPrefix}.groqApiKey`,
        true,
      ) as string;
      if (!apiKey) {
        statusLabel?.setAttribute("value", "Enter an API key first.");
        return;
      }
      statusLabel?.setAttribute("value", "Testing…");
      try {
        const res = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        statusLabel?.setAttribute(
          "value",
          res.ok
            ? "Connection OK."
            : `Failed: ${res.status} ${res.statusText}`,
        );
      } catch (e) {
        statusLabel?.setAttribute("value", `Failed: ${e}`);
      }
    });
}
