import "@eigenpal/docx-editor-react/styles.css";
import {
  DocxEditor,
  type DocxEditorProps,
  type DocxEditorRef,
} from "@eigenpal/docx-editor-react";
import { forwardRef } from "react";

// Thin forwardRef wrapper so the heavy editor bundle (ProseMirror + OOXML
// engine) lives behind a React.lazy boundary — opening a markdown or text
// file must not pull this chunk.
const DocxEditorMount = forwardRef<DocxEditorRef, DocxEditorProps>(
  (props, ref) => <DocxEditor ref={ref} {...props} />,
);
DocxEditorMount.displayName = "DocxEditorMount";

export default DocxEditorMount;
