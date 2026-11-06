/** Namespace-agnostic XML helpers. Spreadsheet parts may use any prefix, so everything matches on the local name. */

export const localName = (element: Element): string => (element.localName || element.tagName).replace(/^.*:/, "");

export function elementChildren(parent: Element | Document | null | undefined): Element[] {
  if (!parent) return [];
  const out: Element[] = [];
  for (const node of Array.from(parent.childNodes)) if (node.nodeType === 1) out.push(node as Element);
  return out;
}

export const child = (parent: Element | Document | null | undefined, name: string): Element | undefined =>
  elementChildren(parent).find((element) => localName(element) === name);

export const childrenNamed = (parent: Element | Document | null | undefined, name: string): Element[] =>
  elementChildren(parent).filter((element) => localName(element) === name);

/** Every descendant with this local name, in document order. */
export function descendants(root: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Element | Document) => {
    for (const element of elementChildren(node)) {
      if (localName(element) === name) out.push(element);
      walk(element);
    }
  };
  walk(root);
  return out;
}

/** A namespaced attribute such as r:id, matched by its local part whatever prefix the file chose. */
export const prefixedAttribute = (element: Element, local: string): string | null =>
  Array.from(element.attributes).find((attribute) => attribute.name.endsWith(`:${local}`))?.value ?? null;
