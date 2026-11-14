/** The build's HTML parser: judge the document a reader receives, including recovered markup. */
import { parse, serializeOuter } from "parse5";
import { escapeHtml } from "../../shared/markup.ts";
import { PAGE_CONTENT, SITE_SOURCE_ATTRIBUTE } from "../../engine/src/workflow/site-sources.ts";

export const CONTENT_INCLUDE = "_includes/page-content.html";

export function pageContentInclude() {
  return `{% if page.source_identity %}<!--${PAGE_CONTENT.start}-->{% endif %}\n{{ include.content }}\n{% if page.source_identity %}<!--${PAGE_CONTENT.end}-->{% endif %}\n`;
}

export function parseSiteHtml(html, options = {}) {
  return parse(html, { scriptingEnabled: false, ...options });
}

/** Parsed attribute values are already entity-decoded; consumers must not decode them again. */
export function siteDocumentLinks(html) {
  const links = [];
  const visit = (node) => {
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === "href" || attribute.name === "src") links.push(attribute.value);
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content !== undefined) visit(node.content);
  };
  visit(parseSiteHtml(html));
  return links;
}

/** Resolve only actual authored-content attributes; rendered code examples never become links. */
export function rewriteRenderedPageLinks(html, resolveTarget, { contentRequired = true, resolveText = null } = {}) {
  const parseErrors = [];
  const document = parseSiteHtml(html, { sourceCodeLocationInfo: true, onParseError: (error) => parseErrors.push(error) });
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content !== undefined) visit(node.content);
  };
  visit(document);
  const starts = nodes.filter((node) => node.nodeName === "#comment" && node.data === PAGE_CONTENT.start);
  const ends = nodes.filter((node) => node.nodeName === "#comment" && node.data === PAGE_CONTENT.end);
  const noBoundary = starts.length === 0 && ends.length === 0;
  if (!(noBoundary && !contentRequired) && (starts.length !== 1 || ends.length !== 1 || starts[0].sourceCodeLocation.endOffset > ends[0].sourceCodeLocation.startOffset)) {
    return { html, rewritten: 0, verifiedReferences: 0, errors: ["the rendered page has no single builder-owned authored-content boundary"] };
  }
  const begin = noBoundary ? Infinity : starts[0].sourceCodeLocation.endOffset;
  const end = noBoundary ? -Infinity : ends[0].sourceCodeLocation.startOffset;
  const edits = [];
  const errors = [];
  let verifiedReferences = 0;
  for (const node of nodes) {
    if (resolveText !== null && (node.nodeName === "#text" || node.nodeName === "#comment") && node.sourceCodeLocation !== undefined) {
      const key = node.nodeName === "#text" ? "value" : "data";
      const answer = resolveText(node[key]);
      if (answer.error !== undefined) errors.push(answer.error);
      else if (answer.target !== node[key]) edits.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset,
        value: serializeOuter({ ...node, [key]: answer.target }, { scriptingEnabled: false }), link: false });
    }
    const source = node.attrs?.find((attribute) => attribute.name === SITE_SOURCE_ATTRIBUTE);
    const urls = (node.attrs ?? []).filter((attribute) => attribute.name === "href" || attribute.name === "src");
    const sourceLocation = node.sourceCodeLocation?.attrs?.[SITE_SOURCE_ATTRIBUTE];
    const tag = node.sourceCodeLocation?.startTag;
    const duplicate = source !== undefined && tag !== undefined && parseErrors.some((error) => error.code === "duplicate-attribute" && error.startOffset >= tag.startOffset && error.startOffset < tag.endOffset);
    if (source !== undefined && (urls.length !== 1 || sourceLocation === undefined || duplicate)) {
      errors.push("builder source reference requires one unambiguous href or src on its own element");
      continue;
    }
    for (const attribute of urls) {
      const name = attribute.prefix === undefined ? attribute.name : `${attribute.prefix}:${attribute.name}`;
      const location = node.sourceCodeLocation?.attrs?.[name];
      if (location === undefined) continue;
      const answer = resolveTarget(attribute.value, { authored: location.startOffset >= begin && location.endOffset <= end,
        ...(source === undefined ? {} : { sourceReference: source.value }) });
      if (answer.error !== undefined) errors.push(answer.error);
      else if (source !== undefined && answer.sourceVerified !== true) errors.push("builder source reference was not verified against the source publish plan");
      else {
        if (answer.target !== attribute.value) edits.push({ start: location.startOffset, end: location.endOffset, value: `${name}="${escapeHtml(answer.target)}"`, link: true });
        if (source !== undefined) {
          edits.push({ start: sourceLocation.startOffset, end: sourceLocation.endOffset, value: "", link: false });
          verifiedReferences += 1;
        }
      }
    }
  }
  for (const edit of edits.sort((left, right) => right.start - left.start)) html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
  return { html, rewritten: edits.filter((edit) => edit.link).length, verifiedReferences, errors };
}
