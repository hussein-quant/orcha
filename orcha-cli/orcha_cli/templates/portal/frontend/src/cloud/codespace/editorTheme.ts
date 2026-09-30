/**
 * CM6 theme for the Code Space editors (EditorPane + DraftEditorPane), built
 * from the V2 design tokens (docs/orcha-v2-design-system.md §1 —
 * static/styles/v2-tokens.css). V2 is dark-only, so this is registered as a
 * DARK theme (`{ dark: true }` — CM picks dark-aware defaults for anything not
 * overridden, e.g. the search panel and tooltips).
 *
 * Values are read from the live `--v2-*` custom properties at construction
 * time (once per editor mount) so a token change in v2-tokens.css re-themes the
 * editor without touching this file; the fallbacks are the same §1 values, used
 * only where computed styles aren't available (jsdom / SSR).
 *
 * Syntax colours reuse the read-only viewer's token mapping
 * (browse.css `.rb-tok-*`: comment → tertiary text, string → diff-add green,
 * number → accent, keyword → info blue) so toggling Edit on/off never recolours
 * the code. Font stack matches `.rb-code` (JetBrains Mono) so the pane never
 * reflows either.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { THREAD_LINE_CLASS } from "./editorThreadMarks";

/** Disables ligatures/contextual alternates — shared with the read view (codespace.css .rb-code). */
export const MONO_FEATURES = '"liga" 0, "calt" 0';

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The resolved V2 palette the editor uses — exported for tests. */
export function editorPalette() {
  return {
    text: cssVar("--v2-text", "#EEEFF2"),
    text2: cssVar("--v2-text-2", "#AAADB7"),
    text3: cssVar("--v2-text-3", "#959AA4"),
    surface: cssVar("--v2-surface", "#191A1D"),
    panel: cssVar("--v2-panel", "#151618"),
    canvas: cssVar("--v2-canvas", "#101113"),
    raised: cssVar("--v2-raised", "#202126"),
    hover: cssVar("--v2-hover", "#25262B"),
    border: cssVar("--v2-border", "#2B2D33"),
    accent: cssVar("--v2-accent", "#8D93F7"),
    accentSoft: cssVar("--v2-accent-soft", "rgba(141, 147, 247, 0.14)"),
    selection: "rgba(141, 147, 247, 0.32)", // same as v2-tokens.css ::selection
    info: cssVar("--v2-info", "#4EA7FC"),
    warn: cssVar("--v2-warn", "#E2A336"),
    danger: cssVar("--v2-danger", "#EE7070"),
    diffAdd: cssVar("--diff-add", "#8FD9AE"),
    fontMono: cssVar("--v2-font-mono", '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'),
  };
}

export function buildEditorTheme(): Extension {
  const p = editorPalette();

  const theme = EditorView.theme({
    "&": {
      color: p.text,
      backgroundColor: p.panel,
      fontSize: "12.5px",
      height: "100%",
    },
    // Same glyphs as the read view (.rb-code): no programming ligatures
    // (=> ≠ ⇒, === ≠ ≡) and none of the UI font's cv01/ss03 alternates.
    ".cm-scroller": { fontFamily: p.fontMono, fontVariantLigatures: "none", fontFeatureSettings: MONO_FEATURES, lineHeight: "20px" },
    ".cm-content": {
      fontFamily: p.fontMono,
      fontVariantLigatures: "none",
      fontFeatureSettings: MONO_FEATURES,
      caretColor: p.accent,
      padding: "8px 0 32px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.accent, borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: p.selection + " !important",
    },
    // Same gutter as the read-only viewer (codespace.css .cs-gutter): panel
    // tone, no rule, right-aligned tabular numbers — toggling Edit never
    // shifts or recolours the code.
    ".cm-gutters": {
      backgroundColor: p.panel,
      color: p.text3,
      border: "none",
    },
    // identical box to the viewer's .cs-gutter (border-box, 4ch + 30px)
    ".cm-lineNumbers .cm-gutterElement": { boxSizing: "border-box", padding: "0 14px 0 16px", minWidth: "calc(4ch + 30px)", fontVariantNumeric: "tabular-nums" },
    // thread markers (editorThreadMarks.ts) = the viewer's .cs-gutter-dot
    [".cm-gutterElement." + THREAD_LINE_CLASS]: { position: "relative" },
    [".cm-gutterElement." + THREAD_LINE_CLASS + "::before"]: {
      content: '""', position: "absolute", left: "8px", top: "7px", width: "6px", height: "6px", borderRadius: "50%", backgroundColor: p.accent,
    },
    ".cm-activeLine": { backgroundColor: p.hover },
    ".cm-activeLineGutter": { backgroundColor: p.hover, color: p.text2 },
    ".cm-line": { lineHeight: "20px", padding: "0 24px 0 4px" }, // = .cs-line-text
    // Focus is shown by the pane's own ring (codespace.css), never a CM outline.
    "&.cm-focused": { outline: "none" },
    ".cm-searchMatch": { backgroundColor: p.accentSoft, outline: "1px solid " + p.accent },
    ".cm-searchMatch-selected": { backgroundColor: p.selection },
    ".cm-panels": { backgroundColor: p.raised, color: p.text },
    ".cm-panels-top": { borderBottom: "1px solid " + p.border },
    ".cm-panels-bottom": { borderTop: "1px solid " + p.border },
    ".cm-panel input, .cm-panel button": { fontFamily: "inherit" },
    ".cm-textfield": {
      backgroundColor: p.canvas,
      color: p.text,
      border: "1px solid " + p.border,
      borderRadius: "6px",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: p.raised,
      color: p.text,
      border: "1px solid " + p.border,
      borderRadius: "6px",
    },
    ".cm-tooltip": { backgroundColor: p.raised, color: p.text, border: "1px solid " + p.border },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: p.accentSoft, outline: "none" },
  }, { dark: true });

  const highlight = HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.text3, fontStyle: "italic" },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: p.diffAdd },
    { tag: [t.number, t.bool, t.null, t.atom], color: p.accent },
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], color: p.info, fontWeight: "500" },
    { tag: [t.typeName, t.className, t.namespace], color: p.warn },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.text },
    { tag: [t.propertyName, t.attributeName], color: p.text2 },
    { tag: [t.heading], color: p.text, fontWeight: "600" },
    { tag: [t.link, t.url], color: p.accent, textDecoration: "underline" },
    { tag: [t.invalid], color: p.danger },
    { tag: [t.meta, t.processingInstruction], color: p.text3 },
  ], { themeType: "dark" });

  return [theme, syntaxHighlighting(highlight)];
}
