// Pretty JSON with one record per line. A generated fixture's envelope (its
// metadata, group names and per-history headers) is indented two spaces per
// level as JSON.stringify would; every subtree the `record` predicate accepts,
// such as one history state or one vector row, is written on a single line.
// A fixture then costs about a line per state instead of sixty, and readers,
// which parse JSON, see no difference. `record` receives the path of keys and
// indices from the root and the subtree at that path.
export function encodeJson(value, record = () => false) {
  const write = (node, path, indent) => {
    if (node === null || typeof node !== 'object' || record(path, node)) return JSON.stringify(node ?? null);
    const inner = `${indent}  `;
    if (Array.isArray(node)) {
      return node.length ? `[\n${node.map((item, index) => inner + write(item, [...path, index], inner)).join(',\n')}\n${indent}]` : '[]';
    }
    const entries = Object.entries(node).filter(([, item]) => item !== undefined);
    return entries.length ? `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, [...path, key], inner)}`).join(',\n')}\n${indent}}` : '{}';
  };
  return `${write(value, [], '')}\n`;
}
