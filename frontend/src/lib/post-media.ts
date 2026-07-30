const MANAGED_MEDIA_PATTERN = /\/api\/media\/([0-9a-f-]{36})\/content(?:[?#][^\s"'<>]*)?/gi;

export function managedMediaId(value: string): string | null {
  const match = value.match(/\/api\/media\/([0-9a-f-]{36})\/content(?:[?#]|$)/i);
  return match?.[1] || null;
}

export function collectManagedMediaIds(...values: unknown[]): string[] {
  const ids = new Set<string>();
  const text = JSON.stringify(values);
  for (const match of text.matchAll(MANAGED_MEDIA_PATTERN)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

export function hasExternalMediaReferences(...values: unknown[]): boolean {
  const text = JSON.stringify(values);
  const urls = text.match(/https?:\\?\/\\?\/[^\s"'<>]+/gi) || [];
  return urls.some((raw) => !raw.replace(/\\\//g, "/").includes("/api/media/"));
}

/** Add a provider-neutral media marker to article tags that reference managed media. */
export function annotateManagedMediaHtml(html: string): string {
  return html.replace(/<([a-z][^>]*)>/gi, (tag) => {
    if (/\sdata-media-id\s*=/.test(tag)) return tag;
    const id = managedMediaId(tag);
    if (!id) return tag;
    return tag.replace(/^<([a-z][a-z0-9-]*)/i, `<$1 data-media-id="${id}"`);
  });
}

export function toDateTimeLocal(value?: string): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return toDateTimeLocal();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function dateTimeLocalToIso(value: string): string {
  return new Date(value).toISOString();
}
