/**
 * Throwaway spike: confirms whether Zotero.Annotations.saveFromJSON() produces
 * a highlight that appears live in an already-open reader tab, without the
 * plugin driving the reader UI itself. Delete once the real pipeline replaces it.
 */
export async function runSaveFromJsonSpike() {
  const pane = ztoolkit.getGlobal("ZoteroPane");
  const selected = pane.getSelectedItems();
  const alertFn = ztoolkit.getGlobal("alert");

  if (!selected.length) {
    alertFn("Select a PDF item (or its attachment) in the library first.");
    return;
  }

  let attachment = selected[0];
  if (!attachment.isAttachment()) {
    const pdfAttachment = attachment
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .find((att) => att.attachmentContentType === "application/pdf");
    if (!pdfAttachment) {
      alertFn("No PDF attachment found on the selected item.");
      return;
    }
    attachment = pdfAttachment;
  }

  const json = {
    key: Zotero.Utilities.generateObjectKey(),
    libraryID: attachment.libraryID,
    type: "highlight",
    text: "SPIKE TEST HIGHLIGHT",
    color: "#ffd400",
    pageLabel: "1",
    sortIndex: "00000|000000|00000",
    position: { pageIndex: 0, rects: [[100, 650, 300, 670]] },
    readOnly: false,
    dateModified: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  ztoolkit.log("[Spike] Calling saveFromJSON on", attachment.key);
  const annotation = await Zotero.Annotations.saveFromJSON(attachment, json);
  ztoolkit.log("[Spike] Created annotation", annotation.key);
  alertFn(
    `Spike annotation ${annotation.key} created on page 1 (bottom-left area). ` +
      `If the PDF is already open in a reader tab, check now whether the highlight appears WITHOUT closing/reopening the tab.`,
  );
}
