import { getString } from "../utils/locale";

/**
 * Registers the Settings pane that holds the Groq API key field. Zotero needs
 * this at startup or the plugin has no way to be configured; the pane's own
 * markup and behaviour live in addon/content/preferences.xhtml and
 * preferenceScript.ts.
 */
export function registerPreferencePane() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}
