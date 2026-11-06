# Preserve existing Word documents

List the source/template in inputPaths for every command that reads it. Inspect content, sections, styles, tables, numbering, fields, media and review markup first. Render the source when its layout controls the result. Prefer a new output revision and preserve the source's design rather than replacing it with the new-document kit.

Use python-docx for supported native edits and ZIP/OOXML for precise preservation when needed. Assigning paragraph.text or cell.text replaces child runs and may lose formatting, hyperlinks, fields, bookmarks and review anchors. A python-docx round trip does not guarantee preservation of every advanced OOXML feature. Do not reconstruct an existing document from flattened extracted text.

For a surgical replacement, locate the inspected part/paragraph and exact occurrence, handle run boundaries, keep the original formatting, and compare untouched ZIP members afterwards. Reject ambiguous matches instead of replacing every occurrence. Do not accept tracked changes or delete comments unless requested.

Comments and tracked edits require real OOXML parts, relationships, anchors, IDs and author/date metadata, not coloured text or a note appended to the end. Inspect these structures after the edit; headless rendering may omit comments. Use only supported library operations and do not invent helper APIs from another runtime.

For a supplied template, retain native styles, section/page settings, images, letterhead and fields. Replace actual anchors/placeholders deliberately. For a matching PDF use convert_document on the completed DOCX and review both formats. Do not invoke Office through model-authored commands or execute macros.

After application read back the requested changes, compare untouched content, validate structure and render every final page. See references/verification.md. Explain material conversion/fidelity limits in the reply.
